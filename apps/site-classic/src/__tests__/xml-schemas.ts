import { readdirSync, readFileSync } from 'node:fs';
import { validateXML } from 'xmllint-wasm';

/**
 * XML Schema validation for the discovery files' tests (HeoPress P07 tasks 3.1, 3.3, 3.7): libxml2's `xmllint` (as
 * WebAssembly) against the schemas in `./xsd` — written for this project from the sitemap protocol, the news sitemap
 * format, RSS 2.0 and RFC 4287. Returns the errors (none: valid).
 */
const dir = new URL('./xsd/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.xsd'));
const preload = files.map((fileName) => ({ fileName, contents: readFileSync(new URL(fileName, dir), 'utf8') }));

export async function schemaErrors(xml: string, schema: 'sitemap.xsd' | 'rss.xsd' | 'atom.xsd'): Promise<string[]> {
  const main = preload.find((f) => f.fileName === schema)!;
  const result = await validateXML({
    xml: [{ fileName: 'document.xml', contents: xml }],
    schema: [main],
    preload: preload.filter((f) => f.fileName !== schema),
    maxMemoryPages: 16384,
  });
  return result.errors.map((e) => e.rawMessage);
}
