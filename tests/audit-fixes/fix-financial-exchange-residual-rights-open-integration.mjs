/** Compatibility entry point for the accepted S1 flow. The canonical test now
 * exercises the real SalesService exchange path rather than constructing an
 * obsolete B/N-only synthetic residual-right graph. */
await import('./fix-financial-exchange-residual-rights-sales-integration.mjs')
