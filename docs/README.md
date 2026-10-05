# Symphony++ Documentation

The guides below describe the running product. The separately labeled
[factory workflow](design/factory-workflow.md) is the approved beta contract.
Its source capabilities are implemented; combined native-host qualification and
installed marketplace cutover are separate from that source delivery.

## Sources Of Truth

| Subject | Authority |
|---|---|
| Runtime behavior and state transitions | Elixir code and behavior tests |
| Agent operating procedure | Packaged `plugins/**/skills/**/SKILL.md` files |
| Human concepts and operations | Current guides in this directory |
| Product direction | [Product](../PRODUCT.md) and the labeled factory target contract |
| Interface design | [Design](../DESIGN.md) |
| Upstream Symphony behavior | [Specification](../SPEC.md) and `elixir/` |
| MCP artifact identity | MCP server identity and runtime artifact tests |

Use Git history for completed designs, cutovers, and experiments. Historical
documents do not remain in the active documentation tree.

## Read By Goal

- Understand the model and boundaries: [Current system](system.md)
- Operate Symphony++: [Operations](operations.md)
- Review trust boundaries: [Security](security.md)
- Develop and validate changes: [Development](development.md)
- Diagnose installed runtime behavior: [Runtime](runtime.md)
- Install portable Codex/Claude procedures: [Portable skills](portable-skills.md)
- Repair delivery state: [Delivery recovery](runbooks/delivery-recovery.md)
- Respond to a permission or secret incident:
  [Security incident](runbooks/security-incident.md)

## Beta Contract

- [Factory workflow](design/factory-workflow.md): roles, small-work and
  architect/UI loops, delivery semantics, visibility, and remaining gaps.
- [Editable diagram](design/factory-workflow.excalidraw) and
  [SVG](design/factory-workflow.svg): the approved human workflow sketch.

## Documentation Rules

- Keep current guides factual; label approved target contracts and link to them
  instead of describing proposed behavior as available.
- Link to packaged skills instead of copying agent procedures.
- Link to code-owned schemas instead of maintaining a second tool inventory.
- Put machine-consumed files with the runtime or plugin that owns them.
- Delete completed plans and cutover notes; Git already preserves them.
