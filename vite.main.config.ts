 
import type { ConfigEnv, UserConfig } from 'vite';
import { defineConfig, mergeConfig } from 'vite';
import { getBuildConfig, getBuildDefine, external, pluginHotRestart } from './vite.base.config';
import tsconfigPaths from 'vite-tsconfig-paths';

// https://vitejs.dev/config
export default defineConfig((env) => {
  const forgeEnv = env as ConfigEnv;
  const { forgeConfigSelf } = forgeEnv as any;
  const define = getBuildDefine(forgeEnv);
  // a build made by the CI of a fork is updated from the releases of that fork: see getUpdateRepository in src/main/autoupdate.ts
  define.__WITSY_UPDATE_REPOSITORY__ = JSON.stringify(process.env.WITSY_UPDATE_REPOSITORY || process.env.GITHUB_REPOSITORY || '');
  // bundled rather than loaded at run time: pdfjs-dist, and archiver, which is an ES module only since
  // version 8 (the main process is CommonJS)
  const mainExternal = external.filter((dependency) => dependency !== 'pdfjs-dist' && dependency !== 'archiver');
  const config: UserConfig = {
    build: {
      lib: {
        entry: forgeConfigSelf.entry!,
        fileName: () => '[name].js',
        formats: ['cjs'],
      },
      sourcemap: true,
      rollupOptions: {
        external: mainExternal,
      },
    },
    test: {
      globals: true,
      environment: 'happy-dom',
    },
    plugins: [tsconfigPaths(), pluginHotRestart('restart')],
    define,
    resolve: {
      // Load the Node.js entry.
      mainFields: ['module', 'jsnext:main', 'jsnext'],
    },
  };

  return mergeConfig(getBuildConfig(forgeEnv), config);
});
