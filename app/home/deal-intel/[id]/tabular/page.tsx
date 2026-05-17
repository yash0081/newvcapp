import { DiligenceMatrix } from "@/components/diligence-matrix/diligence-matrix";

export default async function CompanyTabularPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DiligenceMatrix focusMode initialDealIds={[id]} />;
}

