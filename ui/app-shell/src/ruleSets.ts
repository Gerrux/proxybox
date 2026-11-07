import type { Strings } from "./i18n";

/** Каталог локальный: до выбора набора окно не обращается к его репозиторию.
 *
 *  `kind` — про то, по чему набор сверяется. Доменный ловит имя, под которым
 *  приложение открывает соединение. IP-набор сверяется с адресом назначения, а
 *  имя под FakeIP остаётся именем, и разрешать его ради набора служба не
 *  заставляет, — поэтому такой набор срабатывает только на соединения, открытые
 *  прямо по адресу. Окно говорит об этом в выборе (`rulesIpHint`). */
export type RuleSetKind = "domain" | "ip";

export function ruleSets(s: Strings) {
  const geosite = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-";
  const sets: { name: string; source: string; url: string; kind: RuleSetKind }[] = [
    { name: s.rulesRussiaDomains, source: "SagerNet/sing-geosite", url: `${geosite}category-ru.srs`, kind: "domain" },
    { name: s.rulesRussiaIps, source: "SagerNet/sing-geoip", url: "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs", kind: "ip" },
    { name: s.rulesPrivate, source: "MetaCubeX/meta-rules-dat", url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/private.srs", kind: "ip" },
    ...["Apple", "Microsoft", "Google", "YouTube", "Steam", "Telegram", "Discord", "WhatsApp", "OpenAI", "GitHub"].map((name) => ({
      name, source: "SagerNet/sing-geosite", url: `${geosite}${name.toLowerCase()}.srs`, kind: "domain" as const,
    })),
  ];
  return sets;
}
