import { IDataProvider } from './dataProvider.interface';
import { LaravelApiDataProvider } from './laravelApi.provider';

export * from './dataProvider.interface';
export * from './laravelApi.provider';
export * from './storage.provider';

let activeProviderInstance: IDataProvider | null = null;

export function getDataProvider(): IDataProvider {
  if (activeProviderInstance) {
    return activeProviderInstance;
  }

  console.log('[DataProviderFactory] Initializing LaravelApiDataProvider (Live Laravel API mode)');
  activeProviderInstance = new LaravelApiDataProvider();

  return activeProviderInstance;
}

export function setDataProvider(provider: IDataProvider): void {
  activeProviderInstance = provider;
}
