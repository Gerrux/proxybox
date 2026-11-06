import type { Strings } from "./i18n";

/** Каталог локальный: до выбора набора окно не обращается к его репозиторию. */
export function ruleSets(s: Strings) {
  const geosite = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-";
  return [
    { name: s.rulesRussiaDomains, source: "SagerNet/sing-geosite", url: `${geosite}category-ru.srs` },
    { name: s.rulesRussiaIps, source: "SagerNet/sing-geoip", url: "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs" },
    { name: s.rulesPrivate, source: "MetaCubeX/meta-rules-dat", url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/private.srs" },
    ...["Apple", "Microsoft", "Google", "YouTube", "Steam", "Telegram", "Discord", "WhatsApp", "OpenAI", "GitHub"].map((name) => ({
      name, source: "SagerNet/sing-geosite", url: `${geosite}${name.toLowerCase()}.srs`,
    })),
  ];
}
