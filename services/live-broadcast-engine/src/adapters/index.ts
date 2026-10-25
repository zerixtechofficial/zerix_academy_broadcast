import { IDataProvider } from './dataProvider.interface';
import { MockJsonDataProvider } from './mockJson.provider';
import { LaravelApiDataProvider } from './laravelApi.provider';

export * from './dataProvider.interface';
export * from './mockJson.provider';
export * from './laravelApi.provider';
export * from './storage.provider';

let activeProviderInstance: IDataProvider | null = null;

export function getDataProvider(): IDataProvider {
  if (activeProviderInstance) {
    return activeProviderInstance;
  }

  const mode = (process.env.DATA_SOURCE_MODE || 'mock_json').toLowerCase();

  if (mode === 'laravel_api') {
    console.log('[DataProviderFactory] Initializing LaravelApiDataProvider (Live Laravel API mode)');
    activeProviderInstance = new LaravelApiDataProvider();
  } else {
    console.log('[DataProviderFactory] Initializing MockJsonDataProvider (Standalone Mock JSON mode)');
    activeProviderInstance = new MockJsonDataProvider();
  }

  return activeProviderInstance;
}

export function setDataProvider(provider: IDataProvider): void {
  activeProviderInstance = provider;
}
