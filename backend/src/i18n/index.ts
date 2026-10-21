import { IntlMessageFormat } from 'intl-messageformat';
import en from './messages/en.json';
import fr from './messages/fr.json';

export type Locale = 'en' | 'fr';
const catalogs: Record<Locale, Record<string, string>> = { en, fr };

function asSupportedLocale(value: string | undefined): Locale | null {
  if (!value) return null;
  const language = value.trim().toLowerCase().split(/[-_]/, 1)[0];
  return language === 'en' || language === 'fr' ? language : null;
}

/** Resolve a stored preference first, then the best supported Accept-Language
 * entry. Unsupported languages fall back to the English source catalogue. */
export function resolveLocale(preferred?: string | null, acceptLanguage?: string | string[]): Locale {
  const saved = asSupportedLocale(preferred ?? undefined);
  if (saved) return saved;
  const header = Array.isArray(acceptLanguage) ? acceptLanguage.join(',') : acceptLanguage;
  const candidates = (header ?? '')
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const quality = params.map((param) => /^q\s*=\s*(\d+(?:\.\d+)?)$/i.exec(param.trim()))
        .find(Boolean)?.[1];
      return { locale: asSupportedLocale(tag), quality: quality === undefined ? 1 : Number(quality), index };
    })
    .filter((item): item is { locale: Locale; quality: number; index: number } => item.locale !== null && item.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return candidates[0]?.locale ?? 'en';
}

export function formatMessage(locale: Locale, key: string, values: Record<string, unknown> = {}): string {
  const message = catalogs[locale][key] ?? catalogs.en[key];
  if (!message) return key;
  return String(new IntlMessageFormat(message, locale).format(values));
}

export function localizedErrorMessage(locale: Locale, code: string | undefined, fallback: string): string {
  return code && catalogs.en[`errors.${code}`] ? formatMessage(locale, `errors.${code}`) : fallback;
}
