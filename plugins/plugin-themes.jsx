import { Co, db, Hooks, Server } from "../src/app";

const mpUserTheme = db.map('p_userSettings_theme', db.row.integer(), db.row.text());

let themes = {
  'auto': { name: 'System' },
  'light': { name: 'Light', css: `:root{--bg:#fff;--input-bg:#eee;--accent-warn:#b00;--accent-good:#080;--text-color:#000;--link:#008;--separator:#0008;--table-odd:#7771}` },
  'dark': { name: 'Dark', css: `:root{--bg:#111;--input-bg:#222;--text-color:#fff;--accent-warn:#f77;--accent-good:#7f7;--link:#7af;--separator:#fff8}` },
};
let defaultTheme = themes.auto;

export function registerTheme(key, theme) {
  if (theme['default']) {
    themes = { auto: themes.auto, [key]: theme, ...themes };
    defaultTheme = theme;
  } else {
    themes[key] = theme;
  }
}

Hooks.register('core.tpl.userMenu', (menu, $) => {
  const theme = themes[mpUserTheme.get($.user.userKey)] || defaultTheme;
  menu.push(<>
    <hr />
    <Co.Dropdown href='/manage/settings/theme' label="Theme">
      {Object.entries(themes).map(([k, v]) => <Co.Link action='/manage/settings/theme' args={{ location: 'current', theme: k }} data-selected={v == theme}>{v.name}</Co.Link>)}
    </Co.Dropdown>
  </>);
}, 200);

Server.get('/manage/settings/theme', $ => {
  const theme = themes[mpUserTheme.get($.user.userKey)] || defaultTheme;
  return <Co.Page title="Settings/Theme">
    <Co.MainForm.Start />
    <ul class="form">
      {Object.entries(themes).map(([k, v]) => <p><input type="radio" name="theme" value={k} checked={v == theme} />{v.name}</p>)}
      <hr />
      <Co.InlineMenu>
        <Co.MainForm.End>Apply</Co.MainForm.End>
      </Co.InlineMenu>
    </ul>
  </Co.Page>;
});

Server.post('/manage/settings/theme', $ => {
  mpUserTheme.set($.user.userKey, themes[$.params.theme] ? $.params.theme : null);
  return '/manage/settings/theme';
});

Hooks.register('core.tpl.final', (final, $, user) => {
  const theme = user && themes[mpUserTheme.get(user.userKey)] || defaultTheme;
  if (theme.callback) theme.callback(final, $, user);
  else if (theme.css) $.foot(<style>{theme.css}</style>);
});
