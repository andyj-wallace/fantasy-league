import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getStoredToken } from "@/app/lib/auth";

/** Redirects to /login when no session token is stored — the one auth gate every signed-in-only
 * page uses, instead of each page hand-rolling (or forgetting) its own check. */
export function useRequireAuth(): void {
  const router = useRouter();
  useEffect(() => {
    if (!getStoredToken()) router.push("/login");
  }, [router]);
}
