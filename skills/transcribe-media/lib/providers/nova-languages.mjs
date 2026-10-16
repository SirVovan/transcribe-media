// Официальные таблицы сверены 2026-10-10:
// https://developers.deepgram.com/docs/models-languages-overview
// Только Nova для pre-recorded /v1/listen; Flux, legacy и Whisper вне пакета.
const codes = text => Object.freeze(text.split(/\s+/));
const nova3 = codes('multi af af-ZA ar ar-AE ar-SA ar-QA ar-KW ar-SY ar-LB ar-PS ar-JO ar-EG ar-SD ar-TD ar-MA ar-DZ ar-TN ar-IQ ar-IR hy as as-IN be bn bs bg ca zh-HK zh zh-CN zh-Hans zh-TW zh-Hant hr cs cs-CZ da da-DK nl en en-US en-AU en-GB en-IN en-NZ et fi nl-BE fr fr-CA ka ka-GE de de-CH el gu gu-IN he hi hu id it ja kn kk kk-KZ ko ko-KR lv lt mk ms mr mn ne no ps ps-AF fa pl pt pt-BR pt-PT pa pa-IN ro ru sr sk sl es es-419 sv sv-SE tl ta te th th-TH tr tr-TR uk ur vi');
const nova2 = codes('multi bg ca zh zh-CN zh-Hans zh-TW zh-Hant zh-HK cs da da-DK nl en en-US en-AU en-GB en-NZ en-IN et fi nl-BE fr fr-CA de de-CH el hi hu id it ja ko ko-KR lv lt ms no pl pt pt-BR pt-PT ro ru sk es es-419 sv sv-SE th th-TH tr uk vi');
const medicalEnglish = codes('en en-US en-AU en-CA en-GB en-IE en-IN en-NZ');
export const novaLanguages = Object.freeze({
  'nova-3': nova3, 'nova-2': nova2,
  'nova-3-medical': Object.freeze(['multi', ...medicalEnglish]), 'nova-3-pharma': medicalEnglish,
  ...Object.fromEntries(['meeting', 'phonecall', 'finance', 'conversationalai', 'voicemail', 'video', 'medical', 'drivethru', 'automotive', 'atc'].map(name => [`nova-2-${name}`, codes('en en-US')])),
});
export const novaAliases = Object.freeze({ 'nova-3-general': 'nova-3', 'nova-2-general': 'nova-2' });
