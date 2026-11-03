import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from summoner_assets import MAX_ICON_BYTES, SUMMONER_ICONS, SUMMONER_SOUNDS, check_icon, download_icons, icon_urls


def png(width=64, height=64):
    return b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', width, height) + bytes(9)


class SummonerAssetsTests(unittest.TestCase):
    def test_lists_exactly_the_eleven_approved_icons(self):
        self.assertEqual(set(SUMMONER_ICONS), {
            'cleanse', 'exhaust', 'flash', 'ghost', 'heal', 'smite', 'teleport', 'clarity', 'ignite', 'barrier', 'mark',
        })
        urls = icon_urls('16.21')
        self.assertTrue(all(url.startswith('https://raw.communitydragon.org/16.21/') for url in urls.values()))
        self.assertTrue(urls['teleport'].endswith('/summoner_teleport_new.png'))

    def test_every_icon_has_an_explicit_game_sound_event(self):
        self.assertEqual(set(SUMMONER_SOUNDS), set(SUMMONER_ICONS))
        self.assertEqual(SUMMONER_SOUNDS['flash'], 'Play_sfx_SummonerFlash_OnCast')
        self.assertEqual(SUMMONER_SOUNDS['mark'], 'Play_sfx_SummonerSnowball_OnCast')

    def test_rejects_paths_and_hosts_in_place_of_a_patch_number(self):
        for patch in ['../latest', 'https://example.com', 'latest/other', '', '16.21?x=1']:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                icon_urls(patch)

    def test_rejects_html_truncated_oversized_and_invalid_dimension_icons(self):
        check_icon(png())
        for data in [b'<html>not an icon</html>', png()[:20], png(0), png(2048), png() + bytes(MAX_ICON_BYTES)]:
            with self.assertRaises(ValueError):
                check_icon(data)

    def test_writes_original_pngs_and_keeps_unrelated_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            (output / 'unrelated.txt').write_text('keep')
            paths = download_icons('latest', output, fetch=lambda url: png())
            self.assertEqual(len(paths), 11)
            self.assertTrue(all(path.read_bytes() == png() for path in paths))
            self.assertEqual((output / 'unrelated.txt').read_text(), 'keep')
            self.assertFalse(list(output.glob('*.tmp')))

    def test_leaves_existing_icons_untouched_if_any_download_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            (output / 'flash.png').write_bytes(b'previous')
            def fetch(url):
                if url.endswith('summoner_mark.png'):
                    raise OSError('download failed')
                return png()
            with self.assertRaises(OSError):
                download_icons('latest', output, fetch=fetch)
            self.assertEqual((output / 'flash.png').read_bytes(), b'previous')
            self.assertEqual(len(list(output.iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
