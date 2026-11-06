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

function welcomeSteps(status: Status): Step[] {
  const s = strings(status.lang);
  // В охвате «весь компьютер» список приложений не участвует вовсе, и требовать
  // выбранного там значило бы держать вечно неисполнимый шаг: туда идёт всё.
  const wholeMachine = status.scope === "all" || status.scope === "split";
  return [
    { title: s.welcomeStep1, hint: s.welcomeStep1Hint, done: status.profiles.length > 0 },
    {
      title: s.welcomeStep2,
      hint: wholeMachine ? s.welcomeStep2All : s.welcomeStep2Hint,
      done: wholeMachine || status.apps.some((a) => a.enabled),
      always: wholeMachine,
    },
    { title: s.welcomeStep3, hint: s.welcomeStep3Hint, done: status.tunnel === "up" },
  ];
}

/** Запоминает, что все три шага сбылись, — из корня окна, а не из карточки.
 *  Карточка не рисуется в настройках, и шаги, сбывшиеся пока они открыты, иначе
 *  не запомнились бы: выключенный на ночь туннель возвращал бы карточку тому,
 *  кто прошёл весь путь, — третий шаг снова не сбылся бы. Запись одна и та же,
 *  что у «Скрыть» (`SEEN`): раз сбывшееся навсегда. */
export function useWelcomeDone(status: Status | null): void {
  const done = status != null && welcomeSteps(status).every((step) => step.done);
  useEffect(() => {
    if (done) localStorage.setItem(SEEN, "1");
  }, [done]);
}

export function Welcome({ status, className = "" }: { status: Status; className?: string }) {
  const s = strings(status.lang);
  const [hidden, setHidden] = useState(() => localStorage.getItem(SEEN) === "1");

  const steps = welcomeSteps(status);
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

  // Сбывшееся не рисуем ни кадра: эффект выше гасит карточку уже после
  // отрисовки, и на загрузке с тремя отмеченными шагами она вспыхивала на
  // один кадр, прежде чем уйти. Тот же довод — про отсутствие статуса: пока
  // он не пришёл, отмечать нечего, и шаги показались бы все три невыполненными
  // (`App.tsx` не рисует карточку, пока статуса нет).
  // Туннель, который поднимается прямо сейчас при готовых первых двух шагах, —
  // тот же случай: так выглядит запуск окна поверх уже настроенной службы, и
  // третий шаг сбудется раньше, чем его успеют прочесть. Сорвётся подъём —
  // состояние станет «доступ закрыт», и карточка вернётся.
  const arriving = status.tunnel === "connecting" && steps[0].done && steps[1].done;
  if (hidden || complete || arriving) return null;

  return (
    <Panel
      pad="p-3"
      title={s.welcomeTitle}
      className={`shrink-0 border-b border-edge ${className}`}
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
        <p className="text-sm text-muted">{s.welcomeIntro}</p>
        {/* Нумерованный список, а не набор галочек: порядок тут настоящий —
            включать нечего, пока нет профиля, и выбирать некого, пока не
            включено. Номер заменяется отметкой, когда шаг сбылся. */}
        <ol className="flex flex-col gap-2.5">
          {steps.map((step, i) => (
            <li key={step.title} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-px grid size-5 shrink-0 place-items-center rounded-full border text-xs font-medium ${
                  step.done ? "border-transparent bg-open text-bg" : "border-edge text-muted"
                }`}
              >
                {step.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0">
                {/* Сбывшийся шаг гаснет, но не зачёркивается: зачёркнутое
                    читается как отменённое, а он именно исполнен. */}
                <p className={`text-sm ${step.done ? "text-muted" : "text-ink"}`}>
                  {step.title}
                  {step.done && <span className="sr-only"> — {s.welcomeStepDone}</span>}
                </p>
                {(i === at || step.always) && <p className="text-xs text-muted">{step.hint}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
