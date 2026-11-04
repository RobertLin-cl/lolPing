import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import extract_assets as assets
from summoner_assets import SUMMONER_SOUNDS


def section(tag, body):
    return tag + struct.pack('<I', len(body)) + body


def banks(sounds=SUMMONER_SOUNDS, events=None, audio=None):
    objects = []
    media = []
    for index, event in enumerate(sounds.values()):
        action, sound, source = 3000 + index, 4000 + index, 5000 + index
        objects += [
            (assets.EVENT, assets.fnv1_32(event), bytes([1]) + struct.pack('<I', action)),
            (assets.ACTION, action, struct.pack('<HI', 0, sound)),
            (assets.SOUND_OBJ, sound, struct.pack('<IBI', 0, 0, source)),
        ]
        media.append(struct.pack('<III', source, index, 1))
    hirc = struct.pack('<I', len(objects)) + b''.join(
        struct.pack('<BII', kind, len(body) + 4, oid) + body for kind, oid, body in objects
    )
    return {
        (events or assets.BANK_DIR + 'misc_gameplay_sfx_events.bnk'): section(b'HIRC', hirc),
        (audio or assets.BANK_DIR + 'misc_gameplay_sfx_audio.bnk'): section(b'DIDX', b''.join(media)) + section(b'DATA', bytes(len(sounds))),
    }


class SummonerSoundTests(unittest.TestCase):
    def test_keeps_previous_sounds_when_the_last_decode_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / 'assets' / 'summoners'
            output.mkdir(parents=True)
            for name in SUMMONER_SOUNDS:
                (output / f'{name}.wav').write_bytes(b'previous')
            (output / 'flash.png').write_bytes(b'icon')
            def decode(media, ids, dest, vgmstream, tmp):
                if dest.stem == 'mark':
                    raise RuntimeError('decode failed')
                dest.write_bytes(b'new')
            with patch.object(assets, 'REPO', root), patch.object(assets, 'wad_read', return_value=banks()), \
                    patch.object(assets.shutil, 'which', return_value='available'), \
                    patch.object(assets, 'decode_and_mix', side_effect=decode):
                with self.assertRaisesRegex(RuntimeError, 'decode failed'):
                    assets.extract_summoner_sounds(root, 'vgmstream')
            self.assertTrue(all((output / f'{name}.wav').read_bytes() == b'previous' for name in SUMMONER_SOUNDS))
            self.assertEqual((output / 'flash.png').read_bytes(), b'icon')
            self.assertFalse(list(output.glob('*.tmp')))

    def test_writes_the_complete_set_after_every_decode_succeeds(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def decode(media, ids, dest, vgmstream, tmp):
                dest.write_bytes(dest.stem.encode())
            with patch.object(assets, 'REPO', root), patch.object(assets, 'wad_read', return_value=banks()), \
                    patch.object(assets.shutil, 'which', return_value='available'), \
                    patch.object(assets, 'decode_and_mix', side_effect=decode):
                assets.extract_summoner_sounds(root, 'vgmstream')
            output = root / 'assets' / 'summoners'
            self.assertEqual({file.stem for file in output.glob('*.wav')}, set(SUMMONER_SOUNDS))
            self.assertTrue(all((output / f'{name}.wav').read_bytes() == name.encode() for name in SUMMONER_SOUNDS))
            self.assertFalse(list(output.glob('*.tmp')))

    def test_extracts_the_team_chat_event_from_the_hud_bank_without_changing_other_ui_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / 'assets' / 'ui'
            output.mkdir(parents=True)
            (output / 'ready-intro.ogg').write_bytes(b'previous')
            def decode(media, ids, dest, vgmstream, tmp):
                dest.write_bytes(b'chat')
            source = banks({'chat-message': 'Play_sfx_hud_base_Chat_Team'}, assets.EVENTS_BANK, assets.AUDIO_BANK)
            with patch.object(assets, 'REPO', root), patch.object(assets, 'wad_read', return_value=source), \
                    patch.object(assets.shutil, 'which', return_value='available'), \
                    patch.object(assets, 'decode_and_mix', side_effect=decode):
                assets.extract_chat_sounds(root, 'vgmstream')
            self.assertEqual((output / 'chat-message.wav').read_bytes(), b'chat')
            self.assertEqual((output / 'ready-intro.ogg').read_bytes(), b'previous')

    def test_names_the_summoner_bank_when_an_event_is_missing(self):
        with self.assertRaisesRegex(SystemExit, 'summoner-bank'):
            assets.event_media({}, 'missing', 'summoner-bank')


if __name__ == '__main__':
    unittest.main()
