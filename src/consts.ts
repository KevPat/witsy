
export const kHistoryVersion = 1
export const kDefaultHttpPort = 8090
export const kDefaultWorkspaceId = '00000000-0000-0000-0000-000000000000'
export const kMediaChatId = '00000000-0000-0000-0000-000000000000'

// the page every html artifact is loaded in: a scheme of its own, served by the main process
// (src/main/web_security.ts), so that the artifact does not get the content security policy of the app
export const kArtifactScheme = 'witsy-artifact'
export const kArtifactFrameUrl = `${kArtifactScheme}://frame/`
export const kArtifactReadyMessage = 'witsy-artifact-ready'
export const kArtifactContentMessage = 'witsy-artifact-content'
