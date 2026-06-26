import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";

export default async function TransfersPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const response = await fetch(`${getApiBaseUrl()}/teams/${teamId}/transfers/available`, {
    cache: "no-store",
  });
  const availableTransfers = await response.json();

  return (
    <main>
      <h1>Transfers</h1>
      <pre>{JSON.stringify(availableTransfers, null, 2)}</pre>
    </main>
  );
}
