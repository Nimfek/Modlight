import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetForm } from "@/components/auth/reset-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("reset.title") };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const sp = await searchParams;
  const token = first(sp.token);
  const error = first(sp.error);
  const t = await getTranslations("auth");

  // better-auth redirects here with ?error=INVALID_TOKEN when the link is bad.
  if (!token || error) {
    return (
      <AuthCard
        title={t("reset.expiredTitle")}
        description={t("reset.expiredDescription")}
      >
        <div className="space-y-5 text-center">
          <div className="bg-destructive/10 text-destructive mx-auto grid size-12 place-items-center rounded-2xl ring-1 ring-destructive/20">
            <ShieldAlert className="size-6" />
          </div>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("reset.expiredBody")}
          </p>
          <Link
            href="/forgot"
            className="text-foreground inline-block text-sm font-medium underline-offset-4 hover:underline"
          >
            {t("reset.requestNewLink")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t("reset.title")}
      description={t("reset.description")}
    >
      <ResetForm token={token} />
    </AuthCard>
  );
}
