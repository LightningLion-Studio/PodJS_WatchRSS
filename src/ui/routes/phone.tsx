import { Show } from "solid-js";
import type { ApplicationForegroundSync } from "../../sync/application-foreground.ts";
import { BluetoothConnectionScreen } from "../BluetoothConnectionScreen.tsx";
import { PhoneConnectionUnavailableScreen } from "../PhoneConnectionUnavailableScreen.tsx";
import type { Page, RouteEntry } from "./types.ts";

export interface PhoneRoutesProps {
  entry: RouteEntry;
  page: () => Page;
  active: () => boolean;
  width: number;
  height: number;
  bluetoothSync: Pick<ApplicationForegroundSync, "state" | "subscribe" | "refresh"> & Partial<Pick<ApplicationForegroundSync,"acquireConnectionPage">>;
  onUrl: (url: string, destination: "return" | "add") => void;
  popPage: (skipInternal?: boolean) => boolean;
}

/** Native exposes these as standalone Activities. Formal navigation does not
 * invent a Profile entry: callers must explicitly push the corresponding route. */
export function PhoneRoutes(props: PhoneRoutesProps) {
  return <>
    <Show when={props.page() === "bluetooth-connection"}>
      <BluetoothConnectionScreen
        width={props.width}
        height={props.height}
        active={props.active}
        sync={props.bluetoothSync}
        abilityLabel={props.entry.phoneAbilityLabel}
        returnRemoteUrl={props.entry.returnRemoteUrl}
        onUrl={props.onUrl}
        onDismiss={() => props.popPage()}
        ref={value => { props.entry.list = value; }}
      />
    </Show>
    <Show when={props.page() === "phone-connection-unavailable"}>
      <PhoneConnectionUnavailableScreen
        width={props.width}
        height={props.height}
        message={props.entry.unavailableMessage ?? "当前连接方式不可用"}
      />
    </Show>
  </>;
}
