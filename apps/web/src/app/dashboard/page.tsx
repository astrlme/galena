import type { Metadata } from "next";
import { HomeView } from "./overview.tsx";

export const metadata: Metadata = { title: "Home" };

export default function Home() {
  return <HomeView />;
}
