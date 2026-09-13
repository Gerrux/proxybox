/// <reference types="vite/client" />
import { useState, type ReactNode } from "react";
import "./design-preview.css";
import { FlowConcepts } from "./FlowConcepts";
import { FlowLab } from "./FlowLab";

const variants = [
  ["instrument", "Прибор", "Текущий вариант · маршрут и живая телеметрия"],
  ["daylight", "Светлый", "Светлая панель · крупная типографика и простор"],
  ["console", "Консоль", "Графит и янтарь · плотный технический интерфейс"],
  ["network", "Сетевой пульт", "Ночной синий · маршрут в центре внимания"],
  ["latch", "Засов", "Инвариант первым · цвет состояния полосой во всю шапку"],
  ["paper", "Бумага", "Светлая антиква · волосяные линии, ни одной тени"],
  ["card", "Карточки", "Плавающие карточки · крупные радиусы и мягкая глубина"],
  ["focus", "Один шаг", "Минимализм · выбор страны и одно главное действие"],
  ["guided", "От приложений", "Пошаговый сценарий · приложения → маршрут → подключение"],
  ["launcher", "Поиск действий", "Управление через поиск · действия и страны в одной строке"],
  ["switchboard", "Рубильник", "Кнопки нет · ручку тянут, а под ней живой канал"],
  ["gate", "Проходная", "Приложения по сторонам ворот · галочек нет вовсе"],
  ["sheets", "Шторки", "Ни вкладок, ни панелей · всё приезжает снизу"],
] as const;

export function DesignPreview({ children }: { children: ReactNode }) {
  const [variant, setVariant] = useState<string>("focus");
  return (
    <div className="design-preview" data-design={variant}>
      <aside className="design-picker" aria-label="Варианты дизайна">
        <div className="design-picker-top"><span>Дизайн ProxyBox</span><span>DEV / 13 вариантов</span></div>
        <div className="design-choices">
          {variants.map(([id, title]) => <button key={id} type="button" aria-pressed={variant === id} onClick={() => setVariant(id)}><i className={`swatch-${id}`} />{title}</button>)}
        </div>
        <p>{variants.find(([id]) => id === variant)?.[2]}</p>
      </aside>
      <div className="design-stage">
        {["switchboard", "gate", "sheets"].includes(variant)
          ? <FlowLab key={variant} flow={variant} />
          : ["focus", "guided", "launcher"].includes(variant)
            ? <FlowConcepts key={variant} flow={variant} />
            : children}
      </div>
    </div>
  );
}
