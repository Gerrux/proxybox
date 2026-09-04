import { useEffect, useState } from "react";
import { strings } from "./i18n";
import type { Status } from "./platform";
import { Button, Panel } from "./ui";

/** Первый запуск: что сделать, чтобы продукт заработал.
 *
 *  Список, а не мастер, и это главное решение здесь. Мастер пришлось бы вести
 *  своим состоянием — шаг, «назад», «пропустить», — и это состояние немедленно
 *  разъехалось бы с настоящим: профиль заводят и из CLI, и вставкой в панель, а
 *  приватный режим включают кнопкой в шапке. Список же ничего не помнит: каждый
 *  шаг — вопрос к статусу, который и так приходит каждые две секунды, поэтому
 *  отметка не может соврать по определению.
 *
 *  Дверей в шагах нет намеренно. Кнопка «завести профиль» вела бы на вкладку
 *  профилей, которая стоит прямо под карточкой, — а в пустом списке уже есть
 *  своя кнопка импорта, и в широком окне все три панели видны разом. Вторая
 *  дверь в шаге от первой не помогает, а сообщает, что первую не заметили.
 *
 *  Объяснить инвариант тут важнее, чем провести по шагам: человек, у которого
 *  выбранные приложения остались без сети, читает это как поломку продукта —
 *  и выключает ровно то, ради чего его ставил. */
const SEEN = "pg.welcome";

/** Шаг: подпись, пояснение и то, сбылся ли он. `always` — показывать пояснение
 *  даже у сбывшегося: так помечен шаг, который сбылся не действием человека, и
 *  без объяснения его отметка выглядит чужой. */
type Step = { title: string; hint: string; done: boolean; always?: boolean };

export function Welcome({ status, className = "" }: { status: Status; className?: string }) {
  const s = strings(status.lang);
  const [hidden, setHidden] = useState(() => localStorage.getItem(SEEN) === "1");

  // В охвате «весь компьютер» список приложений не участвует вовсе, и требовать
  // выбранного там значило бы держать вечно неисполнимый шаг: туда идёт всё.
  const wholeMachine = status.scope === "all";
  const steps: Step[] = [
    { title: s.welcomeStep1, hint: s.welcomeStep1Hint, done: status.profiles.length > 0 },
    {
      title: s.welcomeStep2,
      hint: wholeMachine ? s.welcomeStep2All : s.welcomeStep2Hint,
      done: wholeMachine || status.apps.some((a) => a.enabled),
      always: wholeMachine,
    },
    { title: s.welcomeStep3, hint: s.welcomeStep3Hint, done: status.tunnel === "up" },
  ];
  const complete = steps.every((step) => step.done);
  // Пояснение — только у того шага, на котором стоят. Висели они у всех трёх, и
  // карточка вырастала на полкартинки: в окне 700 px высотой она отжимала список
  // профилей за нижний край — вместе с кнопкой импорта, ради которой шаг и
  // читают. Сделанному пояснение уже не нужно, а до следующего ещё дойдут.
  const at = steps.findIndex((step) => !step.done);

  // Сбылись все три — карточка уходит навсегда, а не до следующего запуска.
  // Иначе выключенный на ночь туннель возвращал бы её тому, кто прошёл весь
  // путь ещё месяц назад: третий шаг снова не сбылся, и «первый запуск»
  // случался бы каждое утро.
  useEffect(() => {
    if (complete && !hidden) {
      localStorage.setItem(SEEN, "1");
      setHidden(true);
    }
  }, [complete, hidden]);

  if (hidden) return null;

  return (
    <Panel
      title={s.welcomeTitle}
      className={`shrink-0 ${className}`}
      action={
        <Button
          variant="quiet"
          onClick={() => {
            localStorage.setItem(SEEN, "1");
            setHidden(true);
          }}
        >
          {s.welcomeHide}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted">{s.welcomeIntro}</p>
        {/* Нумерованный список, а не набор галочек: порядок тут настоящий —
            включать нечего, пока нет профиля, и выбирать некого, пока не
            включено. Номер заменяется отметкой, когда шаг сбылся. */}
        <ol className="flex flex-col gap-2.5">
          {steps.map((step, i) => (
            <li key={step.title} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-px grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-medium ${
                  step.done ? "border-transparent bg-open text-bg" : "border-edge text-muted"
                }`}
              >
                {step.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0">
                {/* Сбывшийся шаг гаснет, но не зачёркивается: зачёркнутое
                    читается как отменённое, а он именно исполнен. */}
                <p className={`text-[13px] ${step.done ? "text-muted" : "text-ink"}`}>
                  {step.title}
                  {step.done && <span className="sr-only"> — {s.welcomeStepDone}</span>}
                </p>
                {(i === at || step.always) && <p className="text-[12px] text-muted">{step.hint}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
