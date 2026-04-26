import { redirect } from "next/navigation";

export default function DealPage() {
  // Legacy public.* deal detail route: redirect to the new Deal Intel CRM.
  redirect("/home/deals");
}

