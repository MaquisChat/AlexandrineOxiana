/**
 * A minimal DOM for turndown (package-internal; note-html.ts): plain element and text nodes with
 * exactly what turndown reads — nodeType, nodeName, childNodes, first/last child, siblings,
 * parentNode, data/nodeValue, textContent, getAttribute, getElementsByTagName(…).length,
 * cloneNode and removeChild. No behaviour at all: no parser, no scripts, no URLs resolved.
 * Every walk is iterative (no recursion), so deep trees cannot overflow the stack.
 *
 * (R75: @xmldom/xmldom's live node lists made turndown's per-node checks cost tens of
 * microseconds each; a megabyte of table cells took seconds.)
 */
export type MiniNode = MiniElement | MiniText;

abstract class Base {
  parentNode: MiniElement | null = null;
  previousSibling: MiniNode | null = null;
  nextSibling: MiniNode | null = null;
}

export class MiniText extends Base {
  readonly nodeType = 3;
  readonly nodeName = "#text";
  constructor(public data: string) {
    super();
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(v: string) {
    this.data = v;
  }
  get textContent(): string {
    return this.data;
  }
}

export class MiniElement extends Base {
  readonly nodeType = 1;
  readonly childNodes: MiniNode[] = [];
  private readonly attrs = new Map<string, string>();
  constructor(readonly nodeName: string) {
    super();
  }
  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  appendChild(c: MiniNode): MiniNode {
    const last = this.lastChild;
    c.parentNode = this;
    c.previousSibling = last;
    c.nextSibling = null;
    if (last) last.nextSibling = c;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c: MiniNode): MiniNode {
    const i = this.childNodes.indexOf(c);
    if (i < 0) throw new Error("not a child");
    this.childNodes.splice(i, 1);
    if (c.previousSibling) c.previousSibling.nextSibling = c.nextSibling;
    if (c.nextSibling) c.nextSibling.previousSibling = c.previousSibling;
    c.parentNode = c.previousSibling = c.nextSibling = null;
    return c;
  }
  /** Descendants in document order (iterative). */
  private *walk(): Generator<MiniNode> {
    const stack: MiniNode[] = [...this.childNodes].reverse();
    while (stack.length) {
      const n = stack.pop()!;
      yield n;
      if (n instanceof MiniElement) for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]!);
    }
  }
  get textContent(): string {
    const parts: string[] = [];
    for (const n of this.walk()) if (n instanceof MiniText) parts.push(n.data);
    return parts.join("");
  }
  getElementsByTagName(tag: string): { length: number } {
    const name = tag.toUpperCase();
    let length = 0;
    for (const n of this.walk()) if (n instanceof MiniElement && n.nodeName === name) length++;
    return { length };
  }
  cloneNode(deep = false): MiniElement {
    const copy = (e: MiniElement) => {
      const c = new MiniElement(e.nodeName);
      for (const [k, v] of e.attrs) c.attrs.set(k, v);
      return c;
    };
    const top = copy(this);
    if (!deep) return top;
    const todo: Array<[MiniElement, MiniElement]> = [[this, top]];
    while (todo.length) {
      const [from, to] = todo.pop()!;
      for (const k of from.childNodes) {
        if (k instanceof MiniText) to.appendChild(new MiniText(k.data));
        else {
          const c = copy(k);
          to.appendChild(c);
          todo.push([k, c]);
        }
      }
    }
    return top;
  }
}
