/** Деление списка профилей на группы и то, что про группу считают окно и плашка.
 *
 *  Одно место, а не два: главное окно и плашка из трея строят один и тот же
 *  список — «свои узлы первыми, затем подписки в порядке службы» — и выбирают
 *  один и тот же «быстрейший». Дважды написанная развилка разошлась бы на
 *  первой правке, и один и тот же узел оказывался бы в разных группах в двух
 *  окнах. Здесь только то, что решается данными статуса: порядок строк внутри
 *  группы, поиск и свёрнутость у каждого окна свои. */
import type { Probe, ProfileInfo, Quota, Subscription } from "./platform";

export type Group = {
  /** Адрес подписки; у своих узлов — пустая строка. */
  key: string;
  /** `null` — свои узлы, заведённые руками. */
  sub: Subscription | null;
  /** Все узлы группы в порядке, в каком их отдала служба, без поиска и без
   *  отбора: «отвечают из всего» считается по ним, а не по найденным. */
  all: ProfileInfo[];
};

/** Свои узлы первыми, затем подписки — в порядке, в каком их передали. Своё —
 *  то, чего нет ни в одной подписке: связь знает служба, окно её только
 *  читает. Подписки передают уже в нужном порядке (главное окно подставляет
 *  сюда порядок на время переноса). */
export function groupProfiles(profiles: ProfileInfo[], subscriptions: Subscription[]): Group[] {
  const fromSubs = new Set(subscriptions.flatMap((sub) => sub.nodes));
  const byName = new Map(profiles.map((p) => [p.name, p] as const));
  return [
    { key: "", sub: null, all: profiles.filter((p) => !fromSubs.has(p.name)) },
    ...subscriptions.map((sub) => ({
      key: sub.url,
      sub,
      all: sub.nodes.flatMap((name) => byName.get(name) ?? []),
    })),
  ];
}

/** Самый быстрый из измеренных и всё ещё живущих в списке. Прогон затевают
 *  ради этого выбора, а делать его глазами по сотне строк — то же самое, что
 *  не делать вовсе. */
export function fastestProbe(probes: Probe[], profiles: ProfileInfo[]): Probe | undefined {
  const names = new Set(profiles.map((p) => p.name));
  return probes
    .filter((p) => p.latency_ms != null && names.has(p.name))
    .sort((a, b) => (a.latency_ms ?? 0) - (b.latency_ms ?? 0))[0];
}

/** Сколько узлов группы ответили на последнюю пробу. Ответивший — тот, у кого
 *  есть задержка; неизмеренный и мёртвый считаются одинаково, а «из скольких»
 *  говорит `all.length`. */
export function aliveCount(all: ProfileInfo[], probeOf: ReadonlyMap<string, Probe>): number {
  return all.filter((p) => probeOf.get(p.name)?.latency_ms != null).length;
}

/** Как зовут подписку: имя, если его дали, иначе адрес без `https://` —
 *  `https://` съедает начало строки, а различаются адреса хвостом. `http://`
 *  остаётся на виду: схема — единственное, чем подписка по открытому каналу
 *  отличается от остальных. */
export function subTitle(sub: Subscription): string {
  return sub.name || sub.url.replace(/^https:\/\//, "");
}

/** Что известно про остаток подписки. `null` — панель ничего не прислала: ноль
 *  в полях значит «не прислала», и то же значение стоит у безлимитных с
 *  бессрочными, поэтому про непришедшее молчим, а не пишем «0 B из 0 B».
 *
 *  Израсходовано — это `upload + download`: панели считают их вместе. `total`
 *  равен нулю у безлимитной подписки — и тогда `used` читается как «израсходовано»,
 *  а не как остаток: голое «284 GB» без слова читалось остатком. */
export type QuotaFacts = {
  used: number;
  /** 0 — без лимита. */
  total: number;
  /** Суток до срока; отрицательное — срок прошёл; `null` — срока нет. */
  days: number | null;
  expire: number;
  expired: boolean;
  /** Осталось меньше десятой части лимита. */
  low: boolean;
};

export function quotaFacts(quota: Quota | null | undefined, now = Date.now()): QuotaFacts | null {
  if (!quota) return null;
  const used = quota.upload + quota.download;
  const days = quota.expire > 0 ? (quota.expire * 1000 - now) / 86_400_000 : null;
  if (quota.total <= 0 && used <= 0 && days == null) return null;
  return {
    used,
    total: quota.total,
    days,
    expire: quota.expire,
    expired: days != null && days < 0,
    low: quota.total > 0 && quota.total - used < quota.total / 10,
  };
}

/** Срок подписки вышел. Одно определение на плашку и окно: в плашке это слово
 *  «истекла» в заголовке группы, в окне — красный срок в ячейке. */
export function quotaExpired(quota: Quota | null | undefined): boolean {
  return quotaFacts(quota)?.expired ?? false;
}
