// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { ConnectorSearch } from "@j3-bots/client-runtime";
import {
  addedFrom,
  addedPlace,
  type ConnectorsOpening,
  type ConnectorsPlace,
  listingKey,
  listingPlace,
} from "@j3-bots/client-runtime/presentation";
import { useAnswer } from "@j3-bots/client-runtime/react";
import { grantText } from "@j3-bots/client-runtime/wording";
import type { Bot, Connector, ConnectorId, ConnectorListing } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useI18n } from "../../app/context";
import { useHeldWhileClosing } from "../../lib/useHeldWhileClosing";
import { Button } from "../ui/button";
import { dialogBackdrop, screenDialog } from "../ui/dialog";
import { lineField } from "../ui/field";
import { SkeletonRows } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { AddOwnConnector } from "./AddOwnConnector";
import { ConnectorPage } from "./ConnectorPage";
import { ListingPage } from "./ListingPage";
import { ConnectorTile, StatusWord } from "./parts";
import { type ConnectorsIntents, Failed } from "./screen";

interface ConnectorsDialogProps {
  /** Null while it is closed. */
  readonly opening: ConnectorsOpening | null;
  /**
   * Put aside for another dialog, as Settings when the operator goes to unlock
   * the vault: closed, with its pages and what they hold kept, to come back as
   * they were.
   */
  readonly aside: boolean;
  /** Null until they load. */
  readonly connectors: ReadonlyArray<Connector> | null;
  readonly bots: ReadonlyArray<Bot>;
  /** A connection to the server is open now: adding and changing a connector needs one. */
  readonly connected: boolean;
  readonly intents: ConnectorsIntents;
  readonly onClose: () => void;
}

/**
 * Where the operator finds services for their bots, connects them and looks
 * after them: their connectors and what the gallery features, a search of the
 * gallery, and a page for each. Each page opens over the one before, and Back
 * returns to it. On a phone it takes the screen; from the tablet layout up it
 * is a panel.
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
  readonly opening: ConnectorsOpening;
};

/**
 * What the connectors dialog holds: its pages, as a stack. The last is shown,
 * and Back takes it off.
 */
export function ConnectorsScreen({ titleId, opening, onClose, ...props }: ConnectorsScreenProps) {
  const { t } = useI18n();
  const [stack, setStack] = useState<ReadonlyArray<ConnectorsPlace>>(
    opening.at._tag === "home" ? [opening.at] : [{ _tag: "home" }, opening.at],
  );
  const place = stack.at(-1) ?? { _tag: "home" };
  const go = (next: ConnectorsPlace) => setStack([...stack, next]);
  /** In place of the page shown, so Back skips the form that led to it. */
  const replace = (next: ConnectorsPlace) => setStack([...stack.slice(0, -1), next]);
  const back = () => setStack(stack.slice(0, -1));

  const title = place._tag === "add-own" ? t("addOwn.title") : t("connectors.title");
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
          {title}
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
            intents={props.intents}
            onOpenListing={(listing) => go(listingPlace(props.connectors ?? [], listing))}
            onOpenConnector={(connectorId) =>
              go({ _tag: "connector", connectorId, signIn: false, added: false })
            }
            onAddOwn={() => go({ _tag: "add-own" })}
          />
        )}
        {place._tag === "listing" && (
          <ListingPage
            key={listingKey(place.ref)}
            listingRef={place.ref}
            name={place.name}
            glyph={place.glyph}
            bots={props.bots}
            forBot={opening.forBot}
            connected={props.connected}
            intents={props.intents}
            onAdded={(connector) => replace(addedPlace(connector))}
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
            added={place.added}
            bots={props.bots}
            connected={props.connected}
            intents={props.intents}
            onRemoved={back}
          />
        )}
        {place._tag === "add-own" && (
          <AddOwnConnector
            bots={props.bots}
            forBot={opening.forBot}
            connected={props.connected}
            intents={props.intents}
            onAdded={(connector) => replace(addedPlace(connector))}
          />
        )}
      </div>
    </>
  );
}

/** How long a search waits for the operator to stop typing. */
const SEARCH_PAUSE_MS = 250;

const kindNote: Partial<Record<ConnectorListing["connect"], KeyWith>> = {
  "own-app": "connectors.kind.own-app",
  token: "connectors.kind.token",
  command: "connectors.kind.command",
  unsupported: "connectors.kind.unsupported",
};

/**
 * The screen's first page: a search of the gallery, and with nothing typed,
 * the operator's connectors, each with its status and its bots, then what
 * the gallery features; last, adding one of the operator's own.
 */
function Home({
  connectors,
  bots,
  connected,
  intents,
  onOpenListing,
  onOpenConnector,
  onAddOwn,
}: {
  connectors: ReadonlyArray<Connector> | null;
  bots: ReadonlyArray<Bot>;
  connected: boolean;
  intents: ConnectorsIntents;
  onOpenListing: (listing: ConnectorListing) => void;
  onOpenConnector: (connectorId: ConnectorId) => void;
  onAddOwn: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const allId = useId();
  const allHintId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const featured = useAnswer(`featured:${i18n.locale}`, () => intents.featured(i18n.locale));
  const search = useAnswer<ConnectorSearch>(
    query === "" ? null : `search:${i18n.locale}:${all}:${query}`,
    () => intents.search({ query, language: i18n.locale, all }),
  );
  const searching = typed.trim() !== "";

  const listingRow = (listing: ConnectorListing) => {
    const added = addedFrom(connectors ?? [], listing.ref);
    const note = kindNote[listing.connect];
    return (
      <li key={listingKey(listing.ref)}>
        <Row onClick={() => onOpenListing(listing)}>
          <ConnectorTile name={listing.name} glyph={listing.glyph} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{listing.name}</span>
            <span className="line-clamp-2 text-sm text-muted-foreground">{listing.summary}</span>
            {added !== undefined ? (
              <StatusWord connector={added} />
            ) : (
              note !== undefined && <span className="text-xs text-muted-foreground">{t(note)}</span>
            )}
          </span>
        </Row>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          aria-label={t("connectors.search")}
          placeholder={t("connectors.search")}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          className={`${lineField} ps-9 pe-10 [&::-webkit-search-cancel-button]:hidden`}
        />
        {typed !== "" && (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={t("connectors.search.clear")}
            className="absolute end-0.5 top-1/2 -translate-y-1/2"
            onClick={() => setTyped("")}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {!connected && <p className="text-sm text-muted-foreground">{t("connectors.offline")}</p>}

      {searching ? (
        <Group title={t("connectors.results")}>
          {search.answer._tag === "loading" || query !== typed.trim() ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("connectors.searching")}
            </p>
          ) : search.answer._tag === "failed" ? (
            <Failed text={t("connectors.loadFailed")} onRetry={search.retry} />
          ) : (
            <>
              {search.answer.value.listings.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("connectors.noResults", { query })}
                </p>
              ) : (
                <ul className="-mx-2 flex flex-col">
                  {search.answer.value.listings.map(listingRow)}
                </ul>
              )}
              {search.answer.value.registry === "unavailable" && (
                <p className="text-xs text-muted-foreground">
                  {t("connectors.registryUnavailable")}
                </p>
              )}
            </>
          )}
          <div className="flex flex-col gap-1 pt-1">
            <label htmlFor={allId} className="flex min-h-9 items-center gap-3 text-sm">
              <span className="flex-1">{t("connectors.showAll")}</span>
              <Switch
                id={allId}
                checked={all}
                onCheckedChange={setAll}
                aria-describedby={allHintId}
              />
            </label>
            <p id={allHintId} className="text-xs text-muted-foreground">
              {t("connectors.showAll.hint")}
            </p>
          </div>
        </Group>
      ) : (
        <>
          {connectors === null ? (
            <SkeletonRows />
          ) : (
            connectors.length > 0 && (
              <Group title={t("connectors.yours")}>
                <ul className="-mx-2 flex flex-col">
                  {connectors.map((connector) => (
                    <li key={connector.id}>
                      <Row onClick={() => onOpenConnector(connector.id)}>
                        <ConnectorTile name={connector.name} glyph={connector.glyph} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium">{connector.name}</span>
                          <StatusWord connector={connector} />
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {grantText(connector.grant, bots, i18n)}
                        </span>
                      </Row>
                    </li>
                  ))}
                </ul>
              </Group>
            )
          )}
          <Group title={t("connectors.featured")}>
            {featured.answer._tag === "loading" ? (
              <SkeletonRows count={3} />
            ) : featured.answer._tag === "failed" ? (
              <Failed text={t("connectors.loadFailed")} onRetry={featured.retry} />
            ) : (
              <ul className="-mx-2 flex flex-col">{featured.answer.value.map(listingRow)}</ul>
            )}
          </Group>
        </>
      )}

      <Group title={t("connectors.addOwn")}>
        <Row onClick={onAddOwn}>
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"
          >
            <PlusIcon className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{t("connectors.addOwn")}</span>
            <span className="text-sm text-muted-foreground">{t("connectors.addOwn.hint")}</span>
          </span>
        </Row>
      </Group>
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
