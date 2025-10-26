export const LOCALES = {
  EN: 'en-US',
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW'
} as const;

export type Locale = typeof LOCALES[keyof typeof LOCALES];

export function isChinese(locale: Locale): boolean {
  return locale === LOCALES.ZH_CN || locale === LOCALES.ZH_TW;
}
