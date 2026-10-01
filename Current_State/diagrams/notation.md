# Diagram notation

Every view has an editable JSON source, SVG and architecture specification. Sources list actual named nodes, typed labeled edges, claims and concrete source evidence. JSON is the editable graph format; no external renderer is needed.

- The outer frame denotes package/component ownership for this view, not a claim that every displayed external dependency is inside that package.
- Each node states its role: component, process, boundary, interface, data, message, storage, external. Explicit process and external boxes identify process/trust crossings; a dependency alone is not a security boundary.
- Solid blue: call. Dashed purple: dependency. Dotted green: event/message. Thick brown: data movement. Gray: containment. Dashed red: declared/unimplemented edge.
- Arrows show direction. For bidirectional transports, the label names the exchange. Numbered edge badges connect to the full source → target and operation table below the graph; the table is part of the diagram, so no arrow is unlabeled.
- Storage boxes denote persisted data, except where a node explicitly says memory. “Data” denotes a value, not necessarily persistence.

The rail layout keeps labeled interfaces legible without crossing text. It intentionally favors traceability over a physical deployment map. The system view names process boundaries; package and component views refine ownership. Every diagram is a static interpretation of the linked code, never runtime observation.

[Baseline index](../baseline/index.md) · [Coverage / complete view list](../baseline/coverage.md)
