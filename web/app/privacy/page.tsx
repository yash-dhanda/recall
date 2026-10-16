import Link from "next/link";

export const metadata = { title: "Privacy · Recall" };

export default function PrivacyPage() {
  return (
    <main className="min-h-[100dvh] px-4 py-10 flex justify-center">
      <article className="w-full max-w-[560px] text-[14px] leading-relaxed text-fg-2">
        <p className="text-[11px] font-bold tracking-[0.16em] text-fg">RECALL</p>
        <h1 className="k-text text-[22px] font-medium mt-3 text-fg">Privacy</h1>
        <p className="mt-1 text-fg-3 text-[12.5px]">Last updated 16 October 2026</p>

        <h2 className="mt-6 font-semibold text-fg">What Recall stores</h2>
        <p className="mt-1">
          Your name and email, a password hash if you sign up with a password, the course
          material you upload, and your study history: cards, schedule and test results.
          All of it is kept to your account.
        </p>

        <h2 className="mt-6 font-semibold text-fg">Signing in with Google or GitHub</h2>
        <p className="mt-1">
          Recall receives your name and verified email address from Google or GitHub, and
          nothing else. It does not read your Drive, repositories, contacts or any other
          data, and it does not post anything on your behalf.
        </p>

        <h2 className="mt-6 font-semibold text-fg">Who sees it</h2>
        <p className="mt-1">
          Nobody but you and the site owner. Nothing is sold or shared for advertising. Text
          from your uploaded material is sent to an AI provider (DeepSeek) to write cards
          and questions, and only for that.
        </p>

        <h2 className="mt-6 font-semibold text-fg">Deleting your data</h2>
        <p className="mt-1">
          Email{" "}
          <a className="underline underline-offset-2" href="mailto:yashdhanda001@gmail.com">
            yashdhanda001@gmail.com
          </a>{" "}
          and your account and everything in it will be deleted.
        </p>

        <p className="mt-8 text-[12.5px]">
          <Link href="/login" className="underline underline-offset-2 hover:text-fg">
            Back to sign in
          </Link>
          {" · "}
          <Link href="/terms" className="underline underline-offset-2 hover:text-fg">
            Terms
          </Link>
        </p>
      </article>
    </main>
  );
}
