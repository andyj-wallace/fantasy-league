import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for the CloudFront + S3 deployment (see "Deployment (AWS)" in the architecture
  // doc): `next build` emits a fully static site to ./out — there is no Next server in production.
  // This is why dynamic pages are addressed by query params (?teamId=) instead of path segments.
  output: "export",
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
  // Next's dev server blocks cross-origin requests to /_next/* (including the HMR websocket) by
  // default; without this, loading the dev server from a phone's LAN IP never hydrates. Wildcard
  // covers the whole home subnet so it survives the phone/laptop getting a new DHCP lease.
  allowedDevOrigins: ["192.168.1.*"],
};

export default nextConfig;
