import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";

export default async function SquadBuilderPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const response = await fetch(`${getApiBaseUrl()}/teams/${teamId}`, { cache: "no-store" });
  const team = await response.json();

  return (
    <main>
      <h1>Squad Builder</h1>
      <pre>{JSON.stringify(team, null, 2)}</pre>
    </main>
  );
}
