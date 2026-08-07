import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardHeader, CardBody } from "./card";
import { Tooltip } from "./tooltip";

describe("Badge", () => {
  it("renders each variant and merges a custom class", () => {
    const { rerender } = render(<Badge>default</Badge>);
    expect(screen.getByText("default").className).toContain("border");
    rerender(<Badge variant="solid">solid</Badge>);
    expect(screen.getByText("solid").className).toContain("bg-raised");
    rerender(
      <Badge variant="plain" className="extra">
        plain
      </Badge>,
    );
    expect(screen.getByText("plain").className).toContain("extra");
  });
});

describe("Button", () => {
  it("renders default and explicit variants/sizes and forwards a ref", () => {
    const ref = createRef<HTMLButtonElement>();
    const { rerender } = render(<Button ref={ref}>go</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByText("go").className).toContain("bg-accent");
    for (const variant of ["outline", "ghost", "subtle"] as const) {
      rerender(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByText(variant)).toBeTruthy();
    }
    for (const size of ["sm", "icon", "icon-sm"] as const) {
      rerender(<Button size={size}>{size}</Button>);
      expect(screen.getByText(size)).toBeTruthy();
    }
    const onClick = vi.fn();
    rerender(<Button onClick={onClick}>click</Button>);
    fireEvent.click(screen.getByText("click"));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("Card", () => {
  it("renders the surface, header and body with a forwarded ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Card ref={ref} className="card-x">
        <CardHeader className="hdr">head</CardHeader>
        <CardBody className="body">body</CardBody>
      </Card>,
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(screen.getByText("head").className).toContain("hdr");
    expect(screen.getByText("body").className).toContain("body");
  });
});

describe("Tooltip", () => {
  it("shows on hover/focus and hides on leave/blur (both sides)", () => {
    const { rerender } = render(
      <Tooltip label="hint">
        <span>anchor</span>
      </Tooltip>,
    );
    const anchor = screen.getByText("anchor").parentElement!;
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.mouseEnter(anchor);
    expect(screen.getByRole("tooltip").textContent).toBe("hint");
    fireEvent.mouseLeave(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(anchor);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.blur(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // bottom side branch + custom class
    rerender(
      <Tooltip label="below" side="bottom" className="cls">
        <span>anchor</span>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("anchor").parentElement!);
    expect(screen.getByRole("tooltip").className).toContain("cls");
  });
});
