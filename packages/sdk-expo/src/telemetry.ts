import { AppState, Platform } from 'react-native';
import type { AssetClient, ClientOptions } from '@assetlib/sdk-core';

declare const require: (name: string) => unknown;
type Telemetry = NonNullable<ClientOptions['telemetry']>;
type OptionalModule = {
  default?: OptionalModule;
  nativeApplicationVersion?: unknown;
  nativeBuildVersion?: unknown;
  nativeAppVersion?: unknown;
  expoConfig?: { version?: unknown; ios?: { buildNumber?: unknown }; android?: { versionCode?: unknown } };
};

function optionalApplication(): OptionalModule | undefined {
  try {
    // Expo Metro marks literal requires directly in try/catch as optional.
    const value = require('expo-application') as OptionalModule | undefined;
    return value?.default ?? value;
  } catch { return undefined; }
}

function optionalConstants(): OptionalModule | undefined {
  try {
    const value = require('expo-constants') as OptionalModule | undefined;
    return value?.default ?? value;
  } catch { return undefined; }
}

function runtimeBuild(): Telemetry['build'] {
  try {
    const application = optionalApplication();
    const constants = optionalConstants();
    const os = Platform?.OS;
    const platform = os === 'ios' || os === 'android' || os === 'web' ? os : 'expo';
    const appVersion = application?.nativeApplicationVersion ?? constants?.nativeAppVersion ?? constants?.expoConfig?.version;
    const nativeBuild = application?.nativeBuildVersion ?? constants?.nativeBuildVersion;
    const configuredBuild = os === 'ios' ? constants?.expoConfig?.ios?.buildNumber : os === 'android' ? constants?.expoConfig?.android?.versionCode : undefined;
    const buildNumber = nativeBuild ?? configuredBuild;
    if (typeof appVersion === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(appVersion) && !/\s/.test(appVersion) &&
      (typeof buildNumber === 'string' || typeof buildNumber === 'number') && /^[A-Za-z0-9._+-]{1,64}$/.test(String(buildNumber)) && !/\s/.test(String(buildNumber))) {
      return { platform, appVersion, buildNumber: String(buildNumber) };
    }
  } catch { /* Optional module getters and native bridges can also throw. */ }
  return undefined;
}

export function expoTelemetry(telemetry: ClientOptions['telemetry']): ClientOptions['telemetry'] {
  if (!telemetry?.enabled) return telemetry;
  return {
    ...telemetry,
    sdk: telemetry.sdk ?? { name: 'sdk-expo', version: '0.5.0-preview.1' },
    build: telemetry.build ?? runtimeBuild() ?? { platform: 'expo', appVersion: 'unknown', buildNumber: 'unknown' },
  };
}

export function flushOnBackground(client: AssetClient): void {
  try {
    const subscription = AppState?.addEventListener?.('change', state => {
      if (state === 'background') void client.flush().catch(() => {});
    });
    if (!subscription) return;
    const dispose = client.dispose.bind(client);
    client.dispose = () => {
      try { subscription.remove(); } catch { /* Teardown must not affect the client. */ }
      dispose();
    };
  } catch { /* AppState is optional in non-native renderers. */ }
}
