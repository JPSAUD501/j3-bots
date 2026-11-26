// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { ConnectorsPlace } from "@j3-bots/client-runtime/presentation";
import { grantText, lastChangeText } from "@j3-bots/client-runtime/wording";
import type { Bot, Connector, ConnectorId, Skill } from "@j3-bots/contracts";
import { ArrowLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useI18n, usePresentation } from "../../app/context";
import { useHeldWhileClosing } from "../../lib/useHeldWhileClosing";
import { Button } from "../ui/button";
import { dialogBackdrop, screenDialog } from "../ui/dialog";
import { SkeletonRows } from "../ui/skeleton";
import { ConnectorPage } from "./ConnectorPage";
import { ConnectorTile, ServerLine } from "./parts";
import type { ConnectorsIntents } from "./screen";
import { skillAt, type SkillPlace, SkillPage, SkillsGroup, type SkillsIntents } from "./Skills";

interface ConnectorsDialogProps {
  /** Where it opens; null while it is closed. */
  readonly opening: ConnectorsPlace | null;
  /**
   * Put aside for another dialog, as Settings when the operator goes to their
   * secrets: closed, with its pages and what they hold kept, to come back as
   * they were.
   */
  readonly aside: boolean;
  /** Null until they load. */
  readonly connectors: ReadonlyArray<Connector> | null;
  readonly bots: ReadonlyArray<Bot>;
  /** Every bot's skills and each bot's own; null until they load. */
  readonly skills: ReadonlyArray<Skill> | null;
  /** A connection to the server is open now: changing a connector needs one. */
  readonly connected: boolean;
  readonly intents: ConnectorsIntents;
  readonly skillsIntents: SkillsIntents;
  readonly onClose: () => void;
}

/**
 * Where the operator looks after the services and skills their bots added:
 * their connectors and the skills, and a page for each. Each page opens over
 * the one before, and Back returns to it. On a phone it takes the screen;
 * from the tablet layout up it is a panel.
 */
export function ConnectorsDialog({ opening, aside, onClose, ...rest }: ConnectorsDialogProps) {
  const shown = useHeldWhileClosing(opening);
  const titleId = useId();
  return (
    <Dialog.Root
      open={opening !== null && !aside}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) shown.closed();
      }}
    >
      <Dialog.Portal keepMounted={opening !== null && aside}>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-lg`}
        >
          {shown.held !== null && (
            <ConnectorsScreen
              key={shown.held.opening}
              titleId={titleId}
              opening={shown.held.value}
              onClose={onClose}
              {...rest}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export type ConnectorsScreenProps = Omit<ConnectorsDialogProps, "opening" | "aside"> & {
  /** The id its title takes, which names the dialog that holds it. */
  readonly titleId: string;
  readonly opening: ConnectorsPlace;
};

/**
 * What the connectors dialog holds: its pages, as a stack. The last is shown,
 * and Back takes it off.
 */
export function ConnectorsScreen({ titleId, opening, onClose, ...props }: ConnectorsScreenProps) {
  const { t } = useI18n();
  const from = (place: ConnectorsPlace): ReadonlyArray<ConnectorsPlace | SkillPlace> =>
    place._tag === "home" ? [place] : [{ _tag: "home" }, place];
  const [stack, setStack] = useState(() => from(opening));
  // Opened at another place while it shows, as from the desktop app's quick
  // access with this screen already up: it goes there, over its list.
  const [openedAt, setOpenedAt] = useState(opening);
  if (openedAt !== opening) {
    setOpenedAt(opening);
    setStack(from(opening));
  }
  const place = stack.at(-1) ?? { _tag: "home" };
  const go = (next: ConnectorsPlace | SkillPlace) => setStack([...stack, next]);
  const back = () => setStack(stack.slice(0, -1));

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border ps-2 pe-2">
        {stack.length > 1 ? (
          <Button
            variant="ghost-muted"
            size="icon"
            aria-label={t("connectors.back")}
            onClick={back}
          >
            <ArrowLeftIcon className="rtl:-scale-x-100" />
          </Button>
        ) : (
          <span className="w-2" />
        )}
        <h2 id={titleId} className="display-type min-w-0 flex-1 truncate text-lg">
          {place._tag === "skill" ? t("skills.title") : t("connectors.title")}
        </h2>
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label={t("connectors.close")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {place._tag === "home" && (
          <Home
            connectors={props.connectors}
            bots={props.bots}
            connected={props.connected}
            onOpenConnector={(connectorId) => go({ _tag: "connector", connectorId, signIn: false })}
            skills={props.skills}
            onOpenSkill={(skill) => go({ _tag: "skill", scope: skill.scope, name: skill.name })}
          />
        )}
        {place._tag === "connector" && (
          <ConnectorPage
            key={place.connectorId}
            connector={
              props.connectors?.find((candidate) => candidate.id === place.connectorId) ?? null
            }
            loading={props.connectors === null}
            signInOnOpen={place.signIn}
            bots={props.bots}
            connected={props.connected}
            intents={props.intents}
            onRemoved={back}
          />
        )}
        {place._tag === "skill" && (
          <SkillPage
            key={`${place.scope._tag === "bot" ? place.scope.botId : "all-bots"}/${place.name}`}
            skill={skillAt(props.skills, place)}
            loading={props.skills === null}
            bots={props.bots}
            connected={props.connected}
            intents={props.skillsIntents}
            onRemoved={back}
          />
        )}
      </div>
    </>
  );
}

/**
 * The screen's first page: the operator's connectors, each with its status,
 * its bots and who changed it last, then the skills. Bots add both in
 * conversation; with none yet, each says so in one line.
 */
function Home({
  connectors,
  bots,
  connected,
  onOpenConnector,
  skills,
  onOpenSkill,
}: {
  connectors: ReadonlyArray<Connector> | null;
  bots: ReadonlyArray<Bot>;
  connected: boolean;
  onOpenConnector: (connectorId: ConnectorId) => void;
  skills: ReadonlyArray<Skill> | null;
  onOpenSkill: (skill: Skill) => void;
}) {
  const ctx = usePresentation();
  const i18n = ctx.i18n;
  const { t } = i18n;
  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {!connected && <p className="text-sm text-muted-foreground">{t("connectors.offline")}</p>}
      <Group title={t("connectors.yours")}>
        {connectors === null ? (
          <SkeletonRows />
        ) : connectors.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("connectors.none")}</p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {connectors.map((connector) => (
              <li key={connector.id}>
                <Row onClick={() => onOpenConnector(connector.id)}>
                  <ConnectorTile name={connector.name} glyph={connector.glyph} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{connector.name}</span>
                    <ServerLine connector={connector} />
                  </span>
                  <span className="flex shrink-0 flex-col items-end text-xs text-muted-foreground">
                    <span>{grantText(connector.grant, bots, i18n)}</span>
                    {connector.lastChange !== null && (
                      <span>{lastChangeText(connector.lastChange, bots, ctx)}</span>
                    )}
                  </span>
                </Row>
              </li>
            ))}
          </ul>
        )}
      </Group>
      <SkillsGroup skills={skills} bots={bots} onOpen={onOpenSkill} />
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A row that opens a page: it fills on hover and takes the row's press. */
function Row({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable pressable-row flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-2 text-start hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      {children}
      <ChevronRightIcon
        aria-hidden
        className="mt-2.5 size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
      />
    </button>
  );
}
