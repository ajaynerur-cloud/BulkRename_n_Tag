// App version shown in the header and the Guide. The release build (scripts/android/prepare.mjs, Render build)
// stamps the version, build number and commit below; a plain checkout shows the package.json version as "dev".
export const APP_VERSION = '1.2.0';
export const APP_BUILD = '';
export const APP_COMMIT = '';

/** "v1.2.0 · build 42" (or "v1.2.0 · dev"). */
export const versionLabel = () => `v${APP_VERSION} · ${APP_BUILD ? `build ${APP_BUILD}` : 'dev'}`;
/** Everything, for the tooltip and for copying into a bug report. */
export const versionDetails = () => `NameTag ${APP_VERSION}${APP_BUILD ? `, build ${APP_BUILD}` : ' (dev)'}${APP_COMMIT ? `, commit ${APP_COMMIT}` : ''}`;
