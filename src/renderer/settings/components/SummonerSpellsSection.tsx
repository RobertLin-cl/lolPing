import { Games24Regular, Keyboard24Regular, Speaker224Regular } from '@fluentui/react-icons';
import type { Settings } from '../../../shared/settings';
import type { GreyedRows } from '../greyedRows';
import { useText } from '../text';
import type { Update } from '../useAppState';
import { SettingRow, SwitchRow } from './rows';
import { SummonerSpellPicker } from './SummonerSpellPicker';

export function SummonerSpellsSection({ settings: s, update, grey }: {
  settings: Settings; update: Update; grey: GreyedRows;
}) {
  const t = useText();
  const roomsOff = !s.features.rooms;
  return (
    <>
      <SwitchRow icon={<Games24Regular />} title={t.featureTitle.roomSpells}
        description={roomsOff ? t.featureDesc.roomSpells + ' ' + t.featureNeedsRooms : t.featureDesc.roomSpells}
        checked={s.features.roomSpells} dim={roomsOff} disabled={roomsOff}
        onChange={(v) => void update({ features: { ...s.features, roomSpells: v } })} />
      <SettingRow icon={<Keyboard24Regular />} title={t.summonerD + ' / ' + t.summonerF}
        description={t.summonerSpellDesc} dim={grey.summonerSpells}>
        <SummonerSpellPicker value={{ d: s.summonerD, f: s.summonerF }} disabled={grey.summonerSpells}
          onChange={({ d, f }) => { void update({ summonerD: d, summonerF: f }); }} />
      </SettingRow>
      <SwitchRow icon={<Speaker224Regular />} title={t.summonerSound} description={t.summonerSoundDesc}
        checked={s.summonerSound} onChange={(v) => void update({ summonerSound: v })} dim={grey.summonerSound} />
    </>
  );
}
