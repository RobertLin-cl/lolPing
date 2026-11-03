"""Download the eleven bundled summoner icons from CommunityDragon without image conversion."""
import re
import struct
from pathlib import Path
from urllib.request import Request, urlopen

# Paths from CommunityDragon's default summoner-spells.json; keep the original PNGs.
SUMMONER_ICONS = {
    'cleanse': 'summoner_boost.png',
    'exhaust': 'summoner_exhaust.png',
    'flash': 'summoner_flash.png',
    'ghost': 'summoner_haste.png',
    'heal': 'summoner_heal.png',
    'smite': 'summoner_smite.png',
    'teleport': 'summoner_teleport_new.png',
    'clarity': 'summonermana.png',
    'ignite': 'summonerignite.png',
    'barrier': 'summonerbarrier.png',
    'mark': 'summoner_mark.png',
}
# Event names are embedded in Common.wad.client and resolve in MISC_Gameplay_SFX_events.bnk.
SUMMONER_SOUNDS = {
    'cleanse': 'Play_sfx_SummonerBoost_OnCast',
    'exhaust': 'Play_sfx_SummonerExhaust_OnHit',
    'flash': 'Play_sfx_SummonerFlash_OnCast',
    'ghost': 'Play_sfx_SummonerHaste_OnCast',
    'heal': 'Play_sfx_SummonerHeal_OnCast',
    'smite': 'Play_sfx_SummonerSmite_OnHit',
    'teleport': 'Play_sfx_SummonerTeleport_buffactivate',
    'clarity': 'Play_sfx_SummonerMana_OnCast',
    'ignite': 'Play_sfx_SummonerDot_OnBuffActivate',
    'barrier': 'Play_sfx_SummonerBarrier_OnCast',
    'mark': 'Play_sfx_SummonerSnowball_OnCast',
}
MAX_ICON_BYTES = 1024 * 1024


def icon_urls(patch: str) -> dict[str, str]:
    if not re.fullmatch(r'latest|[0-9]+\.[0-9]+', patch):
        raise ValueError('summoner patch must be latest or a patch number such as 16.21')
    base = f'https://raw.communitydragon.org/{patch}/plugins/rcp-be-lol-game-data/global/default/data/spells/icons2d'
    return {name: f'{base}/{file}' for name, file in SUMMONER_ICONS.items()}


def read_icon(url: str) -> bytes:
    request = Request(url, headers={'User-Agent': 'lolPing asset extractor', 'Accept': 'image/png'})
    with urlopen(request, timeout=30) as response:
        return response.read(MAX_ICON_BYTES + 1)


def check_icon(data: bytes) -> None:
    if len(data) > MAX_ICON_BYTES:
        raise ValueError('summoner icon exceeds 1 MiB')
    if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[8:16] != b'\x00\x00\x00\rIHDR':
        raise ValueError('summoner icon is not a PNG')
    width, height = struct.unpack_from('>II', data, 16)
    if not 1 <= width <= 1024 or not 1 <= height <= 1024:
        raise ValueError('summoner icon dimensions are outside 1-1024 pixels')


def download_icons(patch: str, output: Path, fetch=read_icon) -> list[Path]:
    # Check the whole set before replacing existing icons after a failed download.
    icons = {}
    for name, url in icon_urls(patch).items():
        data = fetch(url)
        check_icon(data)
        icons[name] = data
    output.mkdir(parents=True, exist_ok=True)
    written = []
    for name, data in icons.items():
        dest = output / f'{name}.png'
        pending = dest.with_suffix('.png.tmp')
        try:
            pending.write_bytes(data)
            pending.replace(dest)
        finally:
            pending.unlink(missing_ok=True)
        written.append(dest)
    return written
