import { describe, expect, it } from 'vitest';
import { assertViewModel } from '../theme/validate.ts';
import { sampleViewModels } from '../theme/samples.ts';

/** The page data contract (HeoPress P06 task 2.1): every sample passes; anything outside it is refused. */
describe('assertViewModel', () => {
  it('accepts the sample page data of every page type', () => {
    for (const vm of Object.values(sampleViewModels())) expect(() => assertViewModel(vm)).not.toThrow();
  });
  it('refuses extra, missing or mistyped data', () => {
    const vm = sampleViewModels().item;
    expect(() => assertViewModel({ ...vm, secrets: { key: 'x' } })).toThrow(/additional properties/);
    expect(() => assertViewModel({ ...vm, site: { ...vm.site, databaseUrl: 'postgres://' } })).toThrow(/additional properties/);
    const { seo: _seo, ...noSeo } = vm;
    expect(() => assertViewModel(noSeo)).toThrow(/seo/);
    expect(() => assertViewModel({ ...vm, page: { ...vm.page, type: 'admin' } })).toThrow(/page\/type/);
    expect(() => assertViewModel({ ...vm, list: [{ id: 1 }] })).toThrow(/list/);
  });
});
