// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it } from 'vitest';
import { loadTracingConfig } from '../config';

describe('loadTracingConfig', () => {
  it('defaults to disabled tracing', () => {
    expect(loadTracingConfig({})).toEqual({
      enabled: false,
      provider: 'none',
      serviceName: 'heopress-cms',
      endpoint: undefined,
      samplingRatio: 1,
    });
  });

  it('loads SkyWalking OTLP endpoint from environment variables', () => {
    expect(loadTracingConfig({
      HEOPRESS_TRACING_ENABLED: 'true',
      HEOPRESS_TRACING_PROVIDER: 'skywalking',
      HEOPRESS_SERVICE_NAME: 'cms-test',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://skywalking-oap:11800',
      HEOPRESS_TRACING_SAMPLING_RATIO: '0.25',
    })).toEqual({
      enabled: true,
      provider: 'skywalking',
      serviceName: 'cms-test',
      endpoint: 'http://skywalking-oap:11800',
      samplingRatio: 0.25,
    });
  });

  it('requires an endpoint when tracing is enabled', () => {
    expect(() => loadTracingConfig({
      HEOPRESS_TRACING_ENABLED: 'true',
      HEOPRESS_TRACING_PROVIDER: 'skywalking',
    })).toThrow(/endpoint/i);
  });
});
