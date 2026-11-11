"use client";

import dynamic from "next/dynamic";

// the map library touches window on import, so it must never render on the server
const MapImpl = dynamic(() => import("./MapImpl"), { ssr: false });

export function StoreMap() {
  return <MapImpl />;
}
