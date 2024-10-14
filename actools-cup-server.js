import { AppSettings, appStart } from './src/app';
import './src/endpoints';

for (const plugin of AppSettings.plugins.active) {
  try {
    await import(`./plugins/${plugin}`);
    if (AppSettings.plugins.verbose) echo`Plugin *${plugin} is loaded and ready`;
  } catch (e) {
    e.pluginSkip 
      ? echo`!Skipping *${plugin}: ${e.message.replace(/^[A-Z][^A-Z]/, _ => _.toLowerCase())}` 
      : echo`#Failed to load plugin _${plugin}: =${e}`;
  }
}

appStart();
