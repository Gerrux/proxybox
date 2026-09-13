import { useState } from "react";
import "./flow-concepts.css";

const locations = [
  { name: "Нидерланды", city: "Амстердам", code: "NL", ms: 75 },
  { name: "Швеция", city: "Стокгольм", code: "SE", ms: 92 },
  { name: "Германия", city: "Франкфурт", code: "DE", ms: 48 },
];
const apps = ["Chrome", "Telegram", "Spotify", "Discord", "Steam", "Firefox"];
type Place = typeof locations[number];

export function FlowConcepts({ flow }: { flow: string }) {
  const [place, setPlace] = useState<Place>(locations[0]);
  const [connected, setConnected] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState(["Chrome", "Telegram"]);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState(0);
  const [screen, setScreen] = useState("home");
  const toggle = (app: string) => setSelected((old) => old.includes(app) ? old.filter((a) => a !== app) : [...old, app]);
  const choices = <div className="flow-locations">{locations.map((loc) => <button key={loc.code} onClick={() => { setPlace(loc); setChoosing(false); }} aria-pressed={place.code === loc.code}><span className="flow-code">{loc.code}</span><span><strong>{loc.name}</strong><small>{loc.city}</small></span><span>{loc.ms} мс</span><span>{place.code === loc.code ? "✓" : ""}</span></button>)}</div>;
  const selection = <div className="flow-app-list">{apps.filter((a) => a.toLowerCase().includes(query.toLowerCase())).map((app) => <label key={app}><span className={`flow-app-icon icon-${app.toLowerCase()}`}>{app[0]}</span><strong>{app}</strong><input type="checkbox" checked={selected.includes(app)} onChange={() => toggle(app)} /></label>)}{!apps.some((a) => a.toLowerCase().includes(query.toLowerCase())) && <p className="flow-empty">Приложения не найдены</p>}</div>;
  return <div className={`flow-concept flow-${flow}`}>
    <header className="flow-top"><span className="flow-brand">proxybox<span>®</span></span><span>Интерактивный макет · без изменения сети</span></header>
    {flow === "focus" && <main className="focus-main">
      <div className="focus-status"><i className={connected ? "is-on" : ""} />{connected ? "Соединение установлено" : "Готов к подключению"}</div>
      <h1>{connected ? <>Вы в сети.<br /><span>Через {place.city}.</span></> : <>Ваш интернет.<br /><span>Ваш маршрут.</span></>}</h1>
      <p className="focus-description">{connected ? "Все приложения используют выбранный туннель." : "Выберите точку выхода. Всё остальное уже настроено."}</p>
      <div className="focus-action-area">
        <button className="focus-destination" onClick={() => setChoosing(!choosing)} aria-expanded={choosing}><span className="flow-code">{place.code}</span><span><small>Точка выхода</small><strong>{place.name}</strong></span><span className="focus-latency">{place.ms} мс</span><span>⌄</span></button>
        {choosing && choices}
        <button className="flow-primary" onClick={() => setConnected(!connected)}>{connected ? "Отключить" : "Подключиться"}<span>{connected ? "○" : "↗"}</span></button>
      </div>
      <footer className="focus-footer"><span>Весь компьютер</span><button onClick={() => setScreen(screen === "details" ? "home" : "details")}>{screen === "details" ? "Скрыть детали" : "Детали подключения"}</button></footer>
      {screen === "details" && <div className="flow-details"><span>Профиль<strong>RU-TROJAN-WS (2)</strong></span><span>При обрыве туннеля<strong>Интернет блокируется</strong></span><span>Задержка<strong>{connected ? `${place.ms} мс` : "Нет подключения"}</strong></span></div>}
    </main>}
    {flow === "guided" && <main className="guided-main">
      <nav className="guided-steps" aria-label="Шаги настройки">{["Приложения", "Маршрут", "Подключение"].map((name, i) => <button key={name} aria-current={step === i ? "step" : undefined} onClick={() => setStep(i)} disabled={i > step}><span>{i < step ? "✓" : i + 1}</span>{name}</button>)}</nav>
      <div className="guided-content">
        <span className="flow-eyebrow">{connected && step === 2 ? "Подключение активно" : "Настройте свой доступ"}</span>
        <h1>{["Что подключаем?", "Куда направим трафик?", connected ? "Всё готово." : "Проверим настройки."][step]}</h1>
        <p>{["Выбранные приложения получат интернет через туннель. Остальные останутся без доступа к сети.", "Выберите страну выхода для всех отмеченных приложений.", connected ? "Выбранные приложения подключены через туннель. Остальным доступ закрыт." : "Изменения вступят в силу после подключения."][step]}</p>
        {step === 0 && <><input className="flow-search" aria-label="Найти приложение" placeholder="Найти приложение…" value={query} onChange={(e) => setQuery(e.target.value)} />{selection}</>}
        {step === 1 && choices}
        {step === 2 && <div className="guided-review"><div><span>Приложения</span><strong>{selected.join(", ") || "Не выбраны"}</strong><button onClick={() => setStep(0)}>Изменить</button></div><div><span>Маршрут</span><strong>{place.name} · {place.city}</strong><button onClick={() => setStep(1)}>Изменить</button></div><div><span>Остальные приложения</span><strong>Без доступа в интернет</strong></div></div>}
      </div>
      <footer className="guided-footer"><span>{step === 0 ? `Выбрано: ${selected.length} из ${apps.length}` : `Шаг ${step + 1} из 3`}</span><button className="flow-primary" disabled={selected.length === 0} onClick={() => step < 2 ? setStep(step + 1) : setConnected(!connected)}>{step < 2 ? "Продолжить" : connected ? "Отключить" : "Подключить приложения"}<span>→</span></button></footer>
    </main>}
    {flow === "launcher" && <main className="launcher-main">
      <div className="launcher-summary"><span><i className={connected ? "is-on" : ""} />{connected ? "Подключено" : "Не подключено"}</span><button onClick={() => setConnected(!connected)}>{connected ? "Отключить" : "Подключить"}</button></div>
      <h1>Что хотите сделать?</h1>
      <div className="launcher-input"><span>⌕</span><input aria-label="Найти действие или страну" autoFocus placeholder="Действие, приложение или страна…" value={query} onChange={(e) => { setQuery(e.target.value); setScreen("home"); }} /><kbd>Поиск</kbd></div>
      {screen === "home" && <div className="launcher-results">
        {!query && <div className="flow-eyebrow">Быстрые действия</div>}
        {[
          { label: connected ? "Отключить туннель" : "Подключиться", hint: `${place.name} · весь компьютер`, symbol: "↗", action: () => setConnected(!connected) },
          { label: "Изменить точку выхода", hint: "3 доступных маршрута", symbol: "◎", action: () => setScreen("locations") },
          { label: "Выбрать приложения", hint: `Выбрано ${selected.length} · остальные без сети`, symbol: "▦", action: () => { setQuery(""); setScreen("apps"); } },
          { label: "Проверить подключение", hint: "Состояние и задержка", symbol: "⌁", action: () => setScreen("health") },
        ].filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(query.toLowerCase())).map((item) => <button key={item.label} onClick={item.action}><span className="launcher-symbol">{item.symbol}</span><span><strong>{item.label}</strong><small>{item.hint}</small></span><span>↵</span></button>)}
        {query && locations.filter((loc) => `${loc.name} ${loc.city}`.toLowerCase().includes(query.toLowerCase())).map((loc) => <button key={loc.code} onClick={() => { setPlace(loc); setQuery(""); setScreen("locations"); }}><span className="launcher-symbol">{loc.code}</span><span><strong>{loc.name}</strong><small>Выбрать маршрут · {loc.ms} мс</small></span><span>↵</span></button>)}
        {query && !["подключиться", "отключить туннель", "изменить точку выхода", "выбрать приложения", "проверить подключение", ...locations.map((l) => `${l.name} ${l.city}`), `${place.name} · весь компьютер`, "состояние и задержка", "3 доступных маршрута", `выбрано ${selected.length} · остальные без сети`].some((s) => s.toLowerCase().includes(query.toLowerCase())) && <p className="flow-empty">Ничего не найдено. Попробуйте «приложения» или «Швеция».</p>}
      </div>}
      {screen !== "home" && <section className="launcher-sub"><button className="flow-back" onClick={() => { setScreen("home"); setQuery(""); }}>← Все действия</button><h2>{screen === "locations" ? "Точка выхода" : screen === "apps" ? "Приложения" : "Состояние подключения"}</h2>{screen === "locations" ? choices : screen === "apps" ? <>{selection}<button className="flow-primary" disabled={!selected.length} onClick={() => { setConnected(true); setScreen("home"); }}>Подключить выбранные<span>↗</span></button></> : <div className="flow-details"><span>Туннель<strong>{connected ? "Подключён" : "Выключен"}</strong></span><span>Точка выхода<strong>{place.name}</strong></span><span>Задержка<strong>{connected ? `${place.ms} мс` : "—"}</strong></span></div>}</section>}
      <footer className="launcher-footer">Управление с клавиатуры <span>Tab — выбрать · Enter — выполнить</span></footer>
    </main>}
  </div>;
}
