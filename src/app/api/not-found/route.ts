const nothing = () => new Response(null, { status: 404 });

/** Where the collector's own address sends everything but the collector (see domain/collector-address). */
export { nothing as DELETE, nothing as GET, nothing as OPTIONS, nothing as PATCH, nothing as POST, nothing as PUT };
