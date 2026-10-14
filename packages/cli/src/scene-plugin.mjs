/* assetlib init writes this config plugin into Expo SDK 57 apps: apps built with the iOS 27 SDK (Xcode 27) stop at
   launch unless they adopt the UIScene life cycle, and the SDK 57 iOS template does not. */
export const SCENE_PLUGIN_FILE = 'plugins/with-ios-scene-lifecycle.js';
export const SCENE_PLUGIN = './plugins/with-ios-scene-lifecycle';
export const SCENE_PLUGIN_SOURCE = `// Written by assetlib init. Apps built with the iOS 27 SDK (Xcode 27) must adopt the UIScene life cycle;
// otherwise UIKit stops them at launch. Expo SDK 57's iOS template still creates the window in the app
// delegate, although expo 57 ships ExpoAppSceneDelegate and ExpoReactNativeFactoryProvider for this. When
// Expo generates ios/, this plugin applies the Expo SDK 58 template's setup:
//   - SceneDelegate.swift, a subclass of ExpoAppSceneDelegate, which creates the window and starts React Native;
//   - a single-scene UIApplicationSceneManifest in Info.plist;
//   - an app delegate that provides the React Native factory instead of creating its own window.
// It does nothing on Expo SDK 58 or later, whose template adopts scenes; remove it after upgrading.
const { IOSConfig, withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_DELEGATE = [
  'internal import Expo',
  '',
  '@objc(SceneDelegate)',
  'class SceneDelegate: ExpoAppSceneDelegate {',
  '  // Extension point for config plugins.',
  '}',
  '',
].join('\\n');

const DECLARATION = 'class AppDelegate: ExpoAppDelegate {';
const PROVIDER_DECLARATION = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
// The template's window creation, which the scene delegate now owns.
const WINDOW_START = /\\n#if os\\(iOS\\) \\|\\| os\\(tvOS\\)\\n\\s*window = UIWindow\\(frame: UIScreen\\.main\\.bounds\\)\\n\\s*factory\\.startReactNative\\([^)]*\\)\\n#endif\\n/;

function fail(message) {
  throw new Error('with-ios-scene-lifecycle: ' + message + ' Compare ios/<app>/AppDelegate.swift with the Expo SDK 57 template and update this plugin.');
}

function adoptSceneAppDelegate(contents) {
  let next = contents;
  if (!next.includes(PROVIDER_DECLARATION)) {
    if (!next.includes(DECLARATION)) fail("the AppDelegate declaration is not the Expo SDK 57 template's.");
    next = next.replace(DECLARATION, PROVIDER_DECLARATION);
  }
  if (WINDOW_START.test(next)) {
    next = next.replace(WINDOW_START, '\\n    // SceneDelegate creates the window and starts React Native under the scene-based\\n    // life cycle, which the iOS 27 SDK requires.\\n');
  } else if (next.includes('UIWindow(frame:')) {
    fail('the AppDelegate still creates a window in a form this plugin does not recognize.');
  }
  return next;
}

const withIosSceneLifecycle = config => {
  if (Number.parseInt(config.sdkVersion ?? '', 10) >= 58) return config;
  config = withAppDelegate(config, mod => {
    if (mod.modResults.language !== 'swift') fail('a Swift AppDelegate is required.');
    mod.modResults.contents = adoptSceneAppDelegate(mod.modResults.contents);
    return mod;
  });
  config = withInfoPlist(config, mod => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate' },
        ],
      },
    };
    return mod;
  });
  // An existing SceneDelegate.swift is kept.
  return IOSConfig.XcodeProjectFile.withBuildSourceFile(config, { filePath: 'SceneDelegate.swift', contents: SCENE_DELEGATE, overwrite: false });
};

module.exports = withIosSceneLifecycle;
module.exports.adoptSceneAppDelegate = adoptSceneAppDelegate;
`;
