import { Image } from "@pocketjs/framework/components";

export type ProfileIconName = "person" | "star" | "play-circle" | "phone-android" | "settings" | "info";

export interface ProfileIconProps {
  name: ProfileIconName;
  class?: string;
  size?: number;
}

const sources: Record<ProfileIconName, string> = {
  person: "../assets/icons/person.svg", star: "../assets/icons/star.svg",
  "play-circle": "../assets/icons/play-circle.svg", "phone-android": "../assets/icons/phone-android.svg",
  settings: "../assets/icons/settings.svg", info: "../assets/icons/info.svg"
};
/** Material Icons paths baked by the PocketJS SVG asset pipeline. */
export function ProfileIcon(props: ProfileIconProps) {
  const size = props.size ?? 24;
  return <Image debugName={`ProfileIcon:${props.name}`} class={props.class} style={{width:size,height:size}} src={sources[props.name]} />;
}

export default ProfileIcon;
