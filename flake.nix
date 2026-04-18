{
  description = "knowledge-fabric — Qdrant-backed knowledge base engine with RRF fusion search";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        nodejs = pkgs.nodejs_22;
        npm = nodejs;

        # Build the package from source
        knowledge-fabric = pkgs.stdenv.mkDerivation {
          pname = "knowledge-fabric";
          version = "1.0.0";

          src = ./.;

          nativeBuildInputs = [
            nodejs
            pkgs.typescript
          ];

          buildPhase = ''
            # Install dependencies (production only for package output)
            npm install --ignore-scripts --omit=dev 2>/dev/null || true
            # Compile TypeScript
            npx tsc --outDir $out/dist || true
          '';

          installPhase = ''
            mkdir -p $out/lib
            cp -r dist $out/
            cp package.json $out/
            cp -r lib $out/ 2>/dev/null || true
            cp -r node_modules $out/ 2>/dev/null || true
          '';
        };

        # OCI container image
        container = pkgs.dockerTools.buildLayeredImage {
          name = "knowledge-fabric";
          tag = "latest";
          contents = [
            knowledge-fabric
            nodejs
            pkgs.bash
            pkgs.coreutils
            pkgs.cacert
          ];
          config = {
            Cmd = [
              "${nodejs}/bin/node"
              "${knowledge-fabric}/dist/index.js"
            ];
            Env = [
              "NODE_ENV=production"
              "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
            ];
            WorkingDir = "/data";
          };
        };
      in
      {
        packages.default = knowledge-fabric;
        packages.knowledge-fabric = knowledge-fabric;
        packages.container = container;

        devShells.default = pkgs.mkShell {
          name = "knowledge-fabric-dev";

          packages = [
            nodejs
            pkgs.typescript
          ];

          shellHook = ''
            echo "knowledge-fabric dev shell"
            echo "  node: $(node --version)"
            echo "  npm:  $(npm --version)"
            echo ""
            echo "Commands:"
            echo "  npm install   — install dependencies"
            echo "  npm run build — compile TypeScript"
            echo "  npm run dev   — watch mode"
            echo "  npm run lint  — type-check only"
          '';
        };

        checks = {
          build = knowledge-fabric;
        };
      }
    );
}
