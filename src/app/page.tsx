import type { Metadata } from "next";
import { LandingPageClient } from "@/components/LandingPageClient";

export const metadata: Metadata = {
  title: "LinLearn — Browser-Native Linux & DevOps Training",
  description:
    "Master Linux and DevOps with a real x86 virtual machine running in your browser. " +
    "AI-powered missions, live terminal, quiz arena — no install required.",
  openGraph: {
    title:       "LinLearn — Browser-Native Linux & DevOps Training",
    description: "Real Linux VM in your browser. AI-powered missions. No install required.",
    type:        "website",
  },
};

export default function HomePage() {
  return <LandingPageClient />;
}
