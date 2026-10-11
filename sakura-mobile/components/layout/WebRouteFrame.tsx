import React from 'react';
export type WebRouteFrameProps = { routeName: string; children: React.ReactNode };
export default function WebRouteFrame({ children }: WebRouteFrameProps) { return <>{children}</>; }
