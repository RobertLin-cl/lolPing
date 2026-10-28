import { describe, expect, it } from 'vitest';
import { resolveLang, strings } from '../../src/shared/i18n';
import { ALL_PINGS } from '../../src/shared/pings';
import { normalizeSettings, triggerLabel } from '../../src/shared/settings';

const CHINESE = ['zh-CN', 'zh-TW'] as const;
/** Common characters that Traditional Chinese writes otherwise: one of them in the zh-TW table is a missed conversion. */
const SIMPLIFIED_ONLY = '设们这说时发开关为动网络对会从无显错键号标视览报认让项页选择输闭应将际线连来队讯颜语图实复记录个气门间问题帮请还样点击数单级载务区边转换钮给经过现该轮盘声';

/** Every piece of text in a table: strings as they are, and functions by their source, which holds their template. */
function textsOf(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (typeof v === 'function') return [v.toString()];
  if (v && typeof v === 'object') return Object.values(v).flatMap(textsOf);
  return [];
}

describe('language', () => {
  it('follows the Windows display language when set to auto', () => {
    expect(resolveLang('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveLang('auto', 'zh-TW')).toBe('zh-TW');
    expect(resolveLang('auto', 'en-US')).toBe('en');
    expect(resolveLang('auto', 'de')).toBe('en');
  });

  it('reads Traditional Chinese for Taiwan, Hong Kong, Macao and the traditional script, Simplified for the rest', () => {
    for (const locale of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'zh_TW', 'ZH-tw']) {
      expect(resolveLang('auto', locale), locale).toBe('zh-TW');
    }
    for (const locale of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-HK']) expect(resolveLang('auto', locale), locale).toBe('zh-CN');
    expect(resolveLang('auto', 'zh-TWX')).toBe('zh-CN');
  });

  it('uses an explicit choice over the system language', () => {
    expect(resolveLang('en', 'zh-CN')).toBe('en');
    expect(resolveLang('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLang('zh-TW', 'zh-CN')).toBe('zh-TW');
    expect(resolveLang('zh-CN', 'zh-TW')).toBe('zh-CN');
  });

  it('room privacy text describes relays, not direct connections', () => {
    const en = strings('en');
    const zh = strings('zh-CN');
    expect(en.roomPrivacy).toContain('relays');
    expect(en.roomPrivacy).not.toContain('directly');
    expect(zh.roomPrivacy).toContain('中继');
    expect(en.roomInternet).toBe('Allow internet connections');
    expect(zh.roomInternet).toBe('允许互联网连接');
  });

  it('has every string in every language', () => {
    const en = strings('en');
    for (const lang of CHINESE) {
      const zh = strings(lang);
      expect(Object.keys(zh).sort(), lang).toEqual(Object.keys(en).sort());
      for (const p of ALL_PINGS) expect(zh.pingNames[p.id], `${lang} ${p.id}`).toBeTruthy();
      expect(zh.limitations, lang).toHaveLength(en.limitations.length);
      expect(zh.lang).toBe(lang);
    }
  });

  it('writes Traditional Chinese without the characters only Simplified Chinese uses', () => {
    for (const platform of ['win', 'mac', 'linux'] as const) {
      const found = [...new Set([...textsOf(strings('zh-TW', platform)).join('')].filter((c) => SIMPLIFIED_ONLY.includes(c)))];
      expect(found, platform).toEqual([]);
    }
    // The check itself: the Simplified table is full of them.
    expect(textsOf(strings('zh-CN')).join('')).toMatch(new RegExp(`[${SIMPLIFIED_ONLY}]`));
  });

  it('has every teammate window word in every language', () => {
    const en = strings('en').teammate.ui;
    for (const lang of CHINESE) {
      const zh = strings(lang).teammate.ui;
      expect(Object.keys(zh).sort(), lang).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(zh)) {
        const text = typeof value === 'function' ? (value as (arg: number | string) => string)(1200) : value;
        expect(text.trim(), `${lang} ${key}`).not.toBe('');
      }
    }
  });

  it('has every teammate failure line in every language', () => {
    const en = strings('en').teammate.ask;
    for (const lang of CHINESE) {
      const zh = strings(lang).teammate.ask;
      expect(Object.keys(zh.failed).sort(), lang).toEqual(Object.keys(en.failed).sort());
      for (const [key, value] of Object.entries(zh.failed)) expect(value.trim(), `${lang} ${key}`).not.toBe('');
    }
    expect(en.failed.noProfile).toMatch(/^Set me up first/);
  });

  it('names the part of a file an answer used in both languages', () => {
    const en = strings('en').teammate.ask.usedFile;
    const zh = strings('zh-CN').teammate.ask.usedFile;
    expect(en('paper.pdf', 'page', '3', '4')).toBe('paper.pdf p. 3–4');
    expect(en('deck.pptx', 'slide', '2', '2')).toBe('deck.pptx slide 2');
    expect(en('plan.xlsx', 'sheet', 'Budget', 'Costs')).toBe('plan.xlsx sheets Budget–Costs');
    expect(en('notes.md', 'part', '1', '2')).toBe('notes.md parts 1–2');
    expect(zh('paper.pdf', 'page', '3', '4')).toBe('paper.pdf 第 3–4 页');
    expect(zh('paper.pdf', 'page', '3', '3')).toBe('paper.pdf 第 3 页');
    expect(zh('deck.pptx', 'slide', '2', '5')).toBe('deck.pptx 第 2–5 张幻灯片');
    expect(zh('plan.xlsx', 'sheet', 'Budget', 'Budget')).toBe('plan.xlsx 工作表 Budget');
    expect(zh('plan.xlsx', 'sheet', 'Budget', 'Costs')).toBe('plan.xlsx 工作表 Budget–Costs');
    expect(zh('notes.md', 'part', '1', '2')).toBe('notes.md 第 1–2 部分');
  });

  it('has a teammate label and instruction for every ping in every language', () => {
    for (const lang of ['en', ...CHINESE] as const) {
      const t = strings(lang).teammate.intent;
      for (const p of ALL_PINGS) {
        expect(t[p.id].label.trim(), `${lang} ${p.id} label`).not.toBe('');
        expect(t[p.id].instruction.trim(), `${lang} ${p.id} instruction`).not.toBe('');
      }
    }
    expect(strings('en').teammate.intent.danger.label).toBe("What's wrong");
    expect(strings('zh-CN').teammate.intent.omw.label).toBe('帮我做');
  });

  it('has the same Mac wording in every language', () => {
    const en = strings('en', 'mac');
    for (const lang of CHINESE) {
      const zh = strings(lang, 'mac');
      expect(Object.keys(zh).sort(), lang).toEqual(Object.keys(en).sort());
      expect(zh.limitations, lang).toHaveLength(en.limitations.length);
      expect(zh.launchAtStartup, lang).not.toBe(strings(lang).launchAtStartup);
    }
    expect(en.launchAtStartup).toBe('Open at login');
    expect(strings('en').launchAtStartup).toBe('Launch at Windows startup');
    expect(strings('en', 'mac')).toBe(en); // stable identity: the settings page uses it as a React dependency
  });

  it('names ⌘Z for undo on a Mac and Ctrl + Z elsewhere, in every language', () => {
    for (const platform of ['win', 'linux'] as const) {
      for (const lang of ['en', ...CHINESE] as const) {
        const ui = strings(lang, platform).teammate.ui;
        expect(ui.pasted, `${lang} ${platform} pasted`).toContain('Ctrl + Z');
        expect(ui.formNote, `${lang} ${platform} note`).toContain('Ctrl + Z');
      }
    }
    for (const lang of ['en', ...CHINESE] as const) {
      const ui = strings(lang, 'mac').teammate.ui;
      expect(ui.pasted, `${lang} pasted`).toContain('⌘Z');
      expect(ui.formNote, `${lang} note`).toContain('⌘Z');
      expect(`${ui.pasted}${ui.formNote}`, lang).not.toContain('Ctrl');
      expect(ui.formFill(2), lang).toBe(strings(lang).teammate.ui.formFill(2));
    }
    expect(strings('en', 'mac').teammate.ui.pasted).toBe('Pasted. ⌘Z to undo.');
    expect(strings('zh-CN', 'mac').teammate.ui.pasted).toMatch(/。$/);
  });

  it('words the update checker as specified, with a menu bar toast on a Mac', () => {
    const en = strings('en');
    expect(en.updateAvailable('0.5.1')).toBe('lolPing 0.5.1 is available');
    expect(en.updateToastTitle).toBe('Update available');
    expect(en.updateToastBody('0.5.1')).toBe('lolPing 0.5.1 is ready to download. Update from the tray menu or Settings.');
    expect(en.updateMacSteps).toBe('lolPing downloads the update and opens it. Drag lolPing into Applications, choose Replace, then open it and allow Accessibility again.');
    expect(en.updateMacDialog).toBe('Drag lolPing into Applications and choose Replace. Then open it and allow Accessibility again. lolPing will quit now.');
    expect(en.updateErrDamaged).toBe('The download was damaged. Try again.');
    expect(en.autoUpdateCheckDesc).toBe('Checks GitHub for a new version every few hours. Nothing downloads until you click Update.');
    expect(en.restartingToUpdate).toBe('Restarting to update…');
    expect(en.trayUpdateTo('0.5.1')).toBe('Update to 0.5.1…');
    expect(en.trayDownloading(42)).toBe('Downloading update… 42%');
    expect(strings('en', 'mac').updateToastBody('0.5.1')).toContain('menu bar');
    expect(strings('zh-CN', 'mac').updateToastBody('0.5.1')).toContain('菜单栏');
    expect(strings('zh-CN').updateToastBody('0.5.1')).toContain('托盘');
  });

  it('says that mute and the incoming limit cover emotes as well as pings, and titles update error toasts', () => {
    for (const lang of ['en', ...CHINESE] as const) {
      const t = strings(lang);
      const emote = lang === 'en' ? 'emote' : '表情';
      expect(t.roomMuteDesc).toContain(emote);
      expect(t.roomLimit).toContain(emote);
      expect(t.roomLimitDesc).toContain(emote);
      expect(t.updateErrorToastTitle).not.toBe('');
    }
  });

  it('defaults to auto and rejects unknown values', () => {
    expect(normalizeSettings({}).language).toBe('auto');
    expect(normalizeSettings({ language: 'zh-CN' }).language).toBe('zh-CN');
    expect(normalizeSettings({ language: 'zh-TW' }).language).toBe('zh-TW');
    expect(normalizeSettings({ language: 'fr' }).language).toBe('auto');
  });

  it('translates mouse trigger names only', () => {
    expect(triggerLabel('mouse4', 'zh-CN')).toBe('鼠标侧键 4');
    expect(triggerLabel('mouse4')).toBe('Mouse 4');
    expect(triggerLabel('alt', 'zh-CN')).toBe('Alt');
  });
});
