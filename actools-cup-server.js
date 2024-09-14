import { AppSettings, appStart } from './src/app';
import './src/endpoints';

for (const plugin of AppSettings.plugins.active) {
  try {
    await import(`./plugins/${plugin}`);
    if (AppSettings.plugins.verbose) console.log(`Plugin ${plugin} is loaded and ready`)
  } catch (e) {
    console.warn(`Failed to load plugin ${plugin}: ${e.stack}`);
  }
}

appStart();
