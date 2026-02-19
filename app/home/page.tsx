import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import { ConnectGmailButton } from "@/components/connect-gmail-button";
import { SyncButton } from "@/components/sync-button";
import { DisconnectGmailButton } from "@/components/disconnect-gmail-button";
import { DeleteEmailButton } from "@/components/delete-email-button";
import { EmailListRefresh } from "@/components/email-list-refresh";

async function HomePageContent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/");
  }

  // Query connection separately to avoid issues with nested queries when connection is deleted
  const { data: connection, error: connError } = await supabase
    .from("gmail_connections")
    .select("id, email")
    .eq("user_id", user.id)
    .maybeSingle();

  // If there's an error or no connection, handle gracefully
  if (connError && connError.code !== "PGRST116") {
    // PGRST116 is "no rows returned" which is fine, but other errors are not
    console.error("Error fetching Gmail connection:", connError);
  }

  // Only fetch emails if connection exists (RLS policy already filters deleted_at IS NULL)
  let rawEmails: { id: string; subject: string; from_address: string; date: string; snippet: string }[] = [];
  if (connection) {
    const { data: emails, error: emailsError } = await supabase
      .from("emails")
      .select("id, subject, from_address, date, snippet")
      .eq("gmail_connection_id", connection.id)
      .is("deleted_at", null)
      .order("date", { ascending: false });

    if (emailsError) {
      console.error("Error fetching emails:", emailsError);
      // Continue with empty array if emails can't be fetched
    } else {
      rawEmails = (emails as { id: string; subject: string; from_address: string; date: string; snippet: string }[]) ?? [];
    }
  }
  const emailList = [...rawEmails].sort(
    (a, b) =>
      new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
  );

  return (
    <main className="min-h-screen bg-white flex flex-col">
      <div className="border-b border-gray-200 p-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold">Welcome home</h1>
        <SignOutButton />
      </div>

      <div className="flex-1 p-6 max-w-3xl mx-auto w-full">
        {!connection ? (
          <div className="flex flex-col items-center gap-4">
            <p className="text-gray-600">Connect your Gmail to get started</p>
            <ConnectGmailButton />
          </div>
        ) : (
          <div className="space-y-4">
            <EmailListRefresh />
            <div className="flex items-center justify-between">
              <p className="text-gray-600">
                Gmail connected: <strong>{connection.email}</strong>
              </p>
              <div className="flex items-center gap-2">
                <SyncButton />
                <DisconnectGmailButton />
              </div>
            </div>

            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Emails</h2>
              {emailList.length === 0 ? (
                <p className="text-gray-500 text-sm">
                  No emails yet. Click Sync now to fetch, or wait for new mail.
                </p>
              ) : (
                <ul className="space-y-2 divide-y divide-gray-100">
                  {emailList.map((email) => (
                    <li key={email.id} className="py-3 flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{email.subject || "(No subject)"}</div>
                        <div className="text-sm text-gray-500">
                          From: {email.from_address}
                          {email.date && (
                            <> · {new Date(email.date).toLocaleString()}</>
                          )}
                        </div>
                        {email.snippet && (
                          <div className="text-sm text-gray-600 mt-1 line-clamp-2">
                            {email.snippet}
                          </div>
                        )}
                      </div>
                      <DeleteEmailButton emailId={email.id} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white flex items-center justify-center">Loading...</div>}>
      <HomePageContent />
    </Suspense>
  );
}
