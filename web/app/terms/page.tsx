import Link from "next/link";

export const metadata = { title: "Terms · Recall" };

export default function TermsPage() {
  return (
    <main className="min-h-[100dvh] px-4 py-10 flex justify-center">
      <article className="w-full max-w-[560px] text-[14px] leading-relaxed text-fg-2">
        <p className="text-[11px] font-bold tracking-[0.16em] text-fg">RECALL</p>
        <h1 className="k-text text-[22px] font-medium mt-3 text-fg">Terms</h1>
        <p className="mt-1 text-fg-3 text-[12.5px]">Last updated 16 October 2026</p>

        <h2 className="mt-6 font-semibold text-fg">Use</h2>
        <p className="mt-1">
          Recall is a free study tool run by an individual. Use it for your own studying, and
          only upload material you are allowed to use.
        </p>

        <h2 className="mt-6 font-semibold text-fg">No guarantees</h2>
        <p className="mt-1">
          Cards and questions are partly written by AI and can be wrong. Check them against
          your course material. The service is provided as is, may change or go offline, and
          is not liable for exam results.
        </p>

        <h2 className="mt-6 font-semibold text-fg">Accounts</h2>
        <p className="mt-1">
          Keep your sign-in to yourself. The owner may remove accounts that abuse the
          service. Your data is handled as described in the{" "}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-fg">
            privacy page
          </Link>
          .
        </p>

        <p className="mt-8 text-[12.5px]">
          <Link href="/login" className="underline underline-offset-2 hover:text-fg">
            Back to sign in
          </Link>
        </p>
      </article>
    </main>
  );
}
