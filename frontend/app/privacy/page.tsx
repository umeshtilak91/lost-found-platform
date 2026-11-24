import type { Metadata } from "next";
import { Alert } from "@/components/ui";

export const metadata: Metadata = { title: "Privacy Policy" };

// DRAFT: written to describe what the software actually does. The operator
// (legal entity, contact, grievance officer, jurisdiction) and the retention
// periods marked [REVIEW] must be confirmed by the owner and legal counsel
// before launch (India DPDP Act 2023, GDPR if serving EU users).
export default function PrivacyPage() {
  return (
    <article className="prose-sm mx-auto flex max-w-3xl flex-col gap-4 leading-relaxed">
      <h1 className="text-3xl font-bold">Privacy Policy</h1>
      <Alert tone="warn">Draft for owner and legal review. Sections marked [REVIEW] need confirmation before launch.</Alert>

      <h2 className="mt-4 text-xl font-semibold">Who we are</h2>
      <p>Lost &amp; Found is operated by [REVIEW: legal entity name, address, contact email, grievance officer].</p>

      <h2 className="mt-4 text-xl font-semibold">What we collect</h2>
      <ul className="list-disc pl-6">
        <li>Account: name, email address, and profile picture from your sign-in provider (Google, Apple or email code).</li>
        <li>Optional phone number, stored in international format. It is never shown publicly.</li>
        <li>Listings you post: title, category, description, approximate location text, date, photos, and optional precise coordinates.</li>
        <li>Private messages, ownership claims (including your answers), listing reports, and notifications.</li>
        <li>Technical data: a session cookie, request logs with IP address and request ID, and rate-limit counters.</li>
      </ul>

      <h2 className="mt-4 text-xl font-semibold">What is public</h2>
      <p>
        Listing title, category, description, location text, date, status, photos, your first name and last initial, and an approximate area (about 1 km)
        if you attached coordinates. Your email, phone number, precise coordinates, messages and claim answers are never public.
      </p>

      <h2 className="mt-4 text-xl font-semibold">Payments</h2>
      <p>
        The ₹100 connection fee is processed by our payment provider (Razorpay). To process the payment, your name, email and phone number
        (if saved) are passed to Razorpay. We store the order and payment identifiers, amount and status, never card or bank details. Finder rewards are paid directly between users; we only record the agreed amount and the finder&apos;s confirmation. Payment records are
        kept for accounting even if an account is deleted. [REVIEW: retention period required by tax law]
      </p>

      <h2 className="mt-4 text-xl font-semibold">Photos</h2>
      <p>Uploaded photos are re-encoded and all embedded metadata (including camera GPS location) is removed before they are stored.</p>

      <h2 className="mt-4 text-xl font-semibold">Sharing your phone number</h2>
      <p>
        Your phone number is only revealed to one other person when you switch on sharing inside a specific conversation. You can switch it off at any time;
        removing your number from your account turns off sharing everywhere.
      </p>

      <h2 className="mt-4 text-xl font-semibold">Cookies and tracking</h2>
      <p>
        We use one essential session cookie to keep you signed in and protect forms, and preference cookies for language and time zone. We do not use
        advertising or third-party analytics trackers, so no consent banner is shown.
      </p>
      <p>
        We count visits ourselves without cookies: for each page view we store the page path, the referring website (domain only) and a
        visitor code made from a random key that changes every day, your IP address and your browser type. The daily key is deleted after
        two days, so visits cannot be linked across days or traced back to you, and your IP address is never stored. Browsers that send Do
        Not Track or Global Privacy Control are not counted. Page-view records are deleted after about 13 months.
      </p>

      <h2 className="mt-4 text-xl font-semibold">Email</h2>
      <p>We email sign-in codes and, when enabled, notifications about matches, messages and claims.</p>

      <h2 className="mt-4 text-xl font-semibold">Retention and deletion</h2>
      <ul className="list-disc pl-6">
        <li>You can download all your data from My account at any time.</li>
        <li>
          Deleting your account immediately removes your account, listings, photos, claims, conversations you took part in, and notifications.
        </li>
        <li>Reports you filed and moderator audit records are kept without the link to your account, to protect the community.</li>
        <li>Deleting a single listing removes its photos immediately; the listing record is kept hidden so existing conversations remain readable.</li>
        <li>Sign-in codes expire after 10 minutes. Sessions expire after 14 days of inactivity.</li>
        <li>Server logs are kept for [REVIEW: e.g. 30 days]. Database backups are kept for [REVIEW: e.g. 7–35 days] and then overwritten.</li>
      </ul>

      <h2 className="mt-4 text-xl font-semibold">Processors</h2>
      <p>[REVIEW: hosting provider (e.g. AWS region), email provider, Google/Apple sign-in.]</p>

      <h2 className="mt-4 text-xl font-semibold">Your rights</h2>
      <p>You can access, correct, export and delete your data from My account, or contact [REVIEW: contact] for help.</p>
    </article>
  );
}
