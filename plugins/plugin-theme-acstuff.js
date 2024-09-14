/** A small extension for that acstuff look, extends themes plugin or just overrides the entire theme if themes plugin is not available. */
import { Hooks, pluginSettings } from '../src/app';
import { prepareAsset } from '../src/std' with { type: 'macro' };

// Link to the index page in header:
const Settings = pluginSettings('acstuffTheme', { bgImage: null });
if (!Settings.bgImage) throw new Error(`Plugin is not configured`);

const headerLink = <a class="navbar-brand" href="/"><img src="/res/icon.png" />CUP</a>;
Hooks.register('core.tpl.header', body => body.splice(0, 0, headerLink));

Hooks.register('core.res.style.css', data => data.push(prepareAsset('css', `  
.navbar-brand{float:left;color:var(--text-color);margin-right:20px;font-size:1.2em;margin-top:0px}
.navbar-brand img{height:20px;width:20px;margin:-4px 8px 0 0;vertical-align:text-bottom}`)));

// Theme-altering function, adds a couple of elements and a bit of extra CSS
const themeFn = (final, $, user) => {
  if (!final.header) {
    final.header = <header>{headerLink}</header>;
  }
  $.foot(<>
    <div class="background"></div>
    <div class="bg-header"></div>
    <style>{prepareAsset('css', `
:root {
  --bg: #111 ;
  --input-bg: #0004;
  --input-bg-opaque: #111;
  --text-color: white;
  --accent-warn: #f99;
  --accent-good: #7f7;
  --link: #9bf;
  --separator: #fff8;
}
.background {
  position: fixed;
  background: url( "BG" );
  background-size: cover;
  opacity: 0.35;
  height: 100%;
  width: 100%;
  top: 0;
  left: 0;
  z-index: -1;
}
.bg-header {
  position:fixed;
  top:0;left:0;right:0;height:32px;
  backdrop-filter: blur(10px);
}
.dropdown-content , .undo { 
  backdrop-filter: blur ( 10px ); 
}
header {
  background:none;
}`).replace('BG', Settings.bgImage)}</style>
  </>);
};

let themes;
try {
  themes = await import('./plugin-themes');
} catch { }

if (themes) {
  themes.registerTheme('acstuff', { name: 'AC Stuff', default: true, callback: themeFn });
} else {
  Hooks.register('core.tpl.final', themeFn);
}

